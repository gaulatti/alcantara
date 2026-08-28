import {
  AlertContainer,
  Button,
  Card,
  Checkbox,
  Input,
  LoadingSpinner,
  Modal,
  SectionHeader,
  showAlert,
} from "@gaulatti/bleecker";
import {
  ArrowDown,
  ArrowUp,
  Pencil,
  Plus,
  RadioTower,
  RotateCw,
  Square,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, handleApiError } from "../services/api";
import { useFeatures } from "../hooks/useFeatures";
import { useGlobalProgramId } from "../utils/globalProgram";
import type { Route } from "./+types/broadcasts";

const VIEW_PERMISSION = "broadcast.view";
const OPERATE_PERMISSION = "broadcast.operate";
const MANAGE_PERMISSION = "broadcast.manage";

interface DestinationSummary {
  id: string;
  displayName: string;
  position: number;
  retired: boolean;
}

interface CatalogDestination extends DestinationSummary {
  secretId: string;
  secretVersionId: string;
  retiredAt: string | null;
}

interface DestinationRelayState {
  id: string;
  displayName: string;
  mode: string;
  supervisorHealthy: boolean;
  publisherProcessHealthy: boolean;
}

interface BroadcastState {
  programId: string;
  available: boolean;
  destinations: DestinationSummary[];
  downstream: {
    requestedState: string;
    actualState: string;
    transition: string | null;
    readiness: boolean;
    destinations: DestinationRelayState[];
    activeDestinations: { version: string; destinationIds: string[] } | null;
    pendingDestinations: { version: string; destinationIds: string[] } | null;
    error?: string;
  };
}

interface CommandResult {
  commandId: string;
  action: "reload" | "start" | "stop";
  status: string;
  selectionVersion: string | null;
}

type ConfirmedAction = "start" | "stop" | null;

export function meta({}: Route.MetaArgs) {
  return [
    { title: "Broadcast destinations - Alcantara" },
    {
      name: "description",
      content: "Select and operate versioned public broadcast destinations.",
    },
  ];
}

export default function Broadcasts() {
  const [programId] = useGlobalProgramId();
  const { hasPermission, loading: permissionsLoading } = useFeatures();
  const canView = hasPermission(VIEW_PERMISSION);
  const canOperate = hasPermission(OPERATE_PERMISSION);
  const canManage = hasPermission(MANAGE_PERMISSION);
  const [state, setState] = useState<BroadcastState | null>(null);
  const [catalog, setCatalog] = useState<CatalogDestination[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [validatedSelectionVersion, setValidatedSelectionVersion] = useState<
    string | null
  >(null);
  const [loading, setLoading] = useState(true);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [confirmedAction, setConfirmedAction] = useState<ConfirmedAction>(null);
  const [catalogModalOpen, setCatalogModalOpen] = useState(false);
  const [editingDestination, setEditingDestination] =
    useState<CatalogDestination | null>(null);
  const [catalogForm, setCatalogForm] = useState({
    id: "",
    displayName: "",
    secretId: "",
    secretVersionId: "",
  });

  const load = useCallback(async () => {
    if (!canView) return;
    const [stateResponse, catalogResponse] = await Promise.all([
      api.get<BroadcastState>(
        `/broadcast/programs/${encodeURIComponent(programId)}`,
      ),
      canManage
        ? api.get<CatalogDestination[]>("/broadcast/destinations/catalog")
        : Promise.resolve(null),
    ]);
    setState(stateResponse.data);
    if (catalogResponse) setCatalog(catalogResponse.data);
    const activeIds =
      stateResponse.data.downstream.activeDestinations?.destinationIds ?? [];
    const pendingIds =
      stateResponse.data.downstream.pendingDestinations?.destinationIds ?? [];
    setSelectedIds((current) =>
      current.length > 0
        ? current
        : pendingIds.length > 0
          ? pendingIds
          : activeIds,
    );
  }, [canManage, canView, programId]);

  useEffect(() => {
    if (permissionsLoading) return;
    setLoading(true);
    void load()
      .catch((error) => showAlert(handleApiError(error), "error"))
      .finally(() => setLoading(false));
  }, [load, permissionsLoading]);

  useEffect(() => {
    if (!canView) return;
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible")
        void load().catch(() => undefined);
    }, 5000);
    return () => window.clearInterval(interval);
  }, [canView, load]);

  const selectableDestinations = useMemo(
    () =>
      (state?.destinations ?? []).filter((destination) => !destination.retired),
    [state?.destinations],
  );
  const isStopped =
    state?.downstream.requestedState === "stopped" &&
    state?.downstream.actualState === "stopped" &&
    !state?.downstream.transition;
  const isRunning = state?.downstream.actualState === "running";

  const toggleDestination = (destinationId: string) => {
    setSelectedIds((current) =>
      current.includes(destinationId)
        ? current.filter((id) => id !== destinationId)
        : [...current, destinationId],
    );
    setValidatedSelectionVersion(null);
  };

  const command = async (action: "reload" | "start" | "stop") => {
    setBusyAction(action);
    try {
      const commandId = crypto.randomUUID();
      const response = await api.post<CommandResult>(
        `/broadcast/programs/${encodeURIComponent(programId)}/${action}`,
        {
          commandId,
          confirmed: true,
          ...(action === "stop"
            ? {}
            : {
                destinationIds: selectedIds,
                ...(validatedSelectionVersion
                  ? { selectionVersion: validatedSelectionVersion }
                  : {}),
              }),
        },
      );
      if (response.data.selectionVersion)
        setValidatedSelectionVersion(response.data.selectionVersion);
      showAlert(
        action === "reload"
          ? "Destination selection validated for the next Start."
          : action === "start"
            ? "Television broadcast is Running with the acknowledged selection."
            : "Television broadcast is Stopped.",
        "success",
      );
      await load();
    } catch (error) {
      showAlert(handleApiError(error), "error");
    } finally {
      setBusyAction(null);
      setConfirmedAction(null);
    }
  };

  const openCatalogModal = (destination?: CatalogDestination) => {
    const editing = destination ?? null;
    setEditingDestination(editing);
    setCatalogForm(
      editing
        ? {
            id: editing.id,
            displayName: editing.displayName,
            secretId: editing.secretId,
            secretVersionId: editing.secretVersionId,
          }
        : { id: "", displayName: "", secretId: "", secretVersionId: "" },
    );
    setCatalogModalOpen(true);
  };

  const saveCatalogDestination = async () => {
    setBusyAction("catalog-save");
    try {
      if (editingDestination) {
        await api.put(
          `/broadcast/destinations/${encodeURIComponent(editingDestination.id)}`,
          catalogForm,
        );
      } else {
        await api.post("/broadcast/destinations", catalogForm);
      }
      setCatalogModalOpen(false);
      showAlert(
        editingDestination ? "Destination updated." : "Destination created.",
        "success",
      );
      await load();
    } catch (error) {
      showAlert(handleApiError(error), "error");
    } finally {
      setBusyAction(null);
    }
  };

  const setRetired = async (
    destination: CatalogDestination,
    retired: boolean,
  ) => {
    setBusyAction(`retire-${destination.id}`);
    try {
      await api.post(
        `/broadcast/destinations/${encodeURIComponent(destination.id)}/${retired ? "retire" : "restore"}`,
      );
      showAlert(
        retired
          ? "Destination retired. Active sessions are unchanged."
          : "Destination restored.",
        "success",
      );
      setValidatedSelectionVersion(null);
      await load();
    } catch (error) {
      showAlert(handleApiError(error), "error");
    } finally {
      setBusyAction(null);
    }
  };

  const moveDestination = async (index: number, offset: number) => {
    const next = [...catalog];
    const target = index + offset;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    setBusyAction("catalog-order");
    try {
      await api.put("/broadcast/destinations/order", {
        destinationIds: next.map((destination) => destination.id),
      });
      await load();
    } catch (error) {
      showAlert(handleApiError(error), "error");
    } finally {
      setBusyAction(null);
    }
  };

  if (permissionsLoading || loading) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <LoadingSpinner />
      </div>
    );
  }
  if (!canView) {
    return (
      <div className="mx-auto max-w-3xl p-8">
        <Card>
          <p className="text-sm text-text-secondary">
            You do not have broadcast.view permission.
          </p>
        </Card>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl space-y-6 px-4 py-6 sm:px-6">
      <AlertContainer />
      <div className="flex flex-wrap items-start justify-between gap-4">
        <SectionHeader
          title="Broadcast destinations"
          description={`Choose the public destinations for the television leg of ${programId}. Stream keys remain in Secrets Manager and Croccante.`}
        />
        {canManage ? (
          <Button onClick={() => openCatalogModal()}>
            <Plus size={15} /> Add destination
          </Button>
        ) : null}
      </div>

      <Card>
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-text-secondary">
              Executor state
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <StateBadge
                label={`Requested ${state?.downstream.requestedState ?? "unknown"}`}
                healthy={
                  state?.downstream.requestedState ===
                  state?.downstream.actualState
                }
              />
              <StateBadge
                label={`Actual ${state?.downstream.actualState ?? "unknown"}`}
                healthy={isRunning || isStopped}
              />
              {state?.downstream.transition ? (
                <StateBadge
                  label={state.downstream.transition}
                  healthy={false}
                />
              ) : null}
            </div>
          </div>
          <div className="text-right text-sm text-text-secondary">
            <p>{state?.available ? "Alana reachable" : "Alana unavailable"}</p>
            <p>
              {state?.downstream.readiness
                ? "Pipeline ready"
                : "Pipeline not ready"}
            </p>
          </div>
        </div>
      </Card>

      <Card>
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold text-text-primary">
              Confirmed destination selection
            </h2>
            <p className="mt-1 text-sm text-text-secondary">
              A Start requires at least one current destination. Reload is
              available only while stopped.
            </p>
          </div>
          {validatedSelectionVersion ? (
            <span className="rounded-full border border-sea/30 bg-sea/10 px-3 py-1 text-xs text-sea">
              Validated {validatedSelectionVersion}
            </span>
          ) : null}
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          {selectableDestinations.map((destination) => {
            const relay = state?.downstream.destinations.find(
              (item) => item.id === destination.id,
            );
            return (
              <label
                key={destination.id}
                className="flex cursor-pointer items-start gap-3 rounded-xl border border-sand/20 bg-white/70 p-4 dark:border-sand/40 dark:bg-dark-sand/50"
              >
                <Checkbox
                  checked={selectedIds.includes(destination.id)}
                  onChange={() => toggleDestination(destination.id)}
                  disabled={!canOperate || isRunning || busyAction !== null}
                />
                <span className="min-w-0 flex-1">
                  <span className="block font-medium text-text-primary">
                    {destination.displayName}
                  </span>
                  <span className="block text-xs text-text-secondary">
                    {destination.id}
                  </span>
                  {relay ? (
                    <span className="mt-2 block text-xs text-text-secondary">
                      {relay.mode} · supervisor{" "}
                      {relay.supervisorHealthy ? "healthy" : "unhealthy"} ·
                      publisher{" "}
                      {relay.publisherProcessHealthy ? "healthy" : "unhealthy"}
                    </span>
                  ) : null}
                </span>
              </label>
            );
          })}
          {selectableDestinations.length === 0 ? (
            <p className="text-sm text-text-secondary">
              No configured destinations are available.
            </p>
          ) : null}
        </div>
        {canOperate ? (
          <div className="mt-5 flex flex-wrap justify-end gap-2">
            <Button
              variant="ghost"
              onClick={() => void command("reload")}
              disabled={
                !isStopped ||
                selectedIds.length === 0 ||
                busyAction !== null ||
                !state?.available
              }
            >
              <RotateCw size={15} />{" "}
              {busyAction === "reload" ? "Validating…" : "Reload while stopped"}
            </Button>
            <Button
              onClick={() => setConfirmedAction("start")}
              disabled={
                isRunning ||
                selectedIds.length === 0 ||
                busyAction !== null ||
                !state?.available
              }
            >
              <RadioTower size={15} /> Confirm Start
            </Button>
            <Button
              variant="destructive"
              onClick={() => setConfirmedAction("stop")}
              disabled={!isRunning || busyAction !== null || !state?.available}
            >
              <Square size={15} /> Confirm Stop
            </Button>
          </div>
        ) : (
          <p className="mt-5 text-sm text-text-secondary">
            You can inspect state, but broadcast.operate is required to change
            it.
          </p>
        )}
      </Card>

      {canManage ? (
        <Card>
          <h2 className="text-lg font-semibold text-text-primary">
            Destination catalog
          </h2>
          <p className="mt-1 text-sm text-text-secondary">
            Only catalog managers can see or change version-pinned Secrets
            Manager references. Secret values are never retrieved.
          </p>
          <div className="mt-4 space-y-3">
            {catalog.map((destination, index) => (
              <div
                key={destination.id}
                className="flex flex-wrap items-center gap-3 rounded-xl border border-sand/20 p-4 dark:border-sand/40"
              >
                <div className="min-w-0 flex-1">
                  <p className="font-medium text-text-primary">
                    {destination.displayName}{" "}
                    {destination.retiredAt ? (
                      <span className="text-xs text-red-500">(retired)</span>
                    ) : null}
                  </p>
                  <p className="truncate text-xs text-text-secondary">
                    {destination.id} · {destination.secretId} ·{" "}
                    {destination.secretVersionId}
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`Move ${destination.displayName} up`}
                  onClick={() => void moveDestination(index, -1)}
                  disabled={index === 0 || busyAction !== null}
                >
                  <ArrowUp size={14} />
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`Move ${destination.displayName} down`}
                  onClick={() => void moveDestination(index, 1)}
                  disabled={index === catalog.length - 1 || busyAction !== null}
                >
                  <ArrowDown size={14} />
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => openCatalogModal(destination)}
                >
                  <Pencil size={14} /> Edit
                </Button>
                <Button
                  size="sm"
                  variant={destination.retiredAt ? "ghost" : "destructive"}
                  onClick={() =>
                    void setRetired(destination, !destination.retiredAt)
                  }
                  disabled={busyAction !== null}
                >
                  <Trash2 size={14} />{" "}
                  {destination.retiredAt ? "Restore" : "Retire"}
                </Button>
              </div>
            ))}
          </div>
        </Card>
      ) : null}

      <Modal
        isOpen={confirmedAction !== null}
        onClose={() => setConfirmedAction(null)}
        title={
          confirmedAction === "start"
            ? "Confirm television Start"
            : "Confirm television Stop"
        }
      >
        <div className="space-y-4">
          <p className="text-sm text-text-secondary">
            {confirmedAction === "start"
              ? `Start ${programId}'s television leg with ${selectedIds.length} immutable destination${selectedIds.length === 1 ? "" : "s"}? Running will appear only after Alana and Croccante acknowledge this exact selection.`
              : `Stop ${programId}'s television leg? Destination changes remain unavailable until Alana acknowledges Stopped.`}
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setConfirmedAction(null)}>
              Cancel
            </Button>
            <Button
              variant={confirmedAction === "stop" ? "destructive" : "primary"}
              onClick={() => confirmedAction && void command(confirmedAction)}
              disabled={busyAction !== null}
            >
              {busyAction
                ? "Sending…"
                : confirmedAction === "start"
                  ? "Start broadcast"
                  : "Stop broadcast"}
            </Button>
          </div>
        </div>
      </Modal>

      <Modal
        isOpen={catalogModalOpen}
        onClose={() => setCatalogModalOpen(false)}
        title={editingDestination ? "Edit destination" : "Add destination"}
      >
        <div className="space-y-4">
          <label className="block text-sm font-medium text-text-primary">
            Opaque destination ID
            <Input
              className="mt-1"
              value={catalogForm.id}
              disabled={Boolean(editingDestination)}
              onChange={(event) =>
                setCatalogForm((current) => ({
                  ...current,
                  id: event.target.value,
                }))
              }
              placeholder="primary"
            />
          </label>
          <label className="block text-sm font-medium text-text-primary">
            Display name
            <Input
              className="mt-1"
              value={catalogForm.displayName}
              onChange={(event) =>
                setCatalogForm((current) => ({
                  ...current,
                  displayName: event.target.value,
                }))
              }
              placeholder="Primary platform"
            />
          </label>
          <label className="block text-sm font-medium text-text-primary">
            Secrets Manager reference
            <Input
              className="mt-1"
              value={catalogForm.secretId}
              onChange={(event) =>
                setCatalogForm((current) => ({
                  ...current,
                  secretId: event.target.value,
                }))
              }
              placeholder="broadcast/production/primary"
            />
          </label>
          <label className="block text-sm font-medium text-text-primary">
            Pinned secret version ID
            <Input
              className="mt-1"
              value={catalogForm.secretVersionId}
              onChange={(event) =>
                setCatalogForm((current) => ({
                  ...current,
                  secretVersionId: event.target.value,
                }))
              }
              placeholder="00000000-0000-0000-0000-000000000000"
            />
          </label>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setCatalogModalOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => void saveCatalogDestination()}
              disabled={busyAction !== null}
            >
              {busyAction === "catalog-save" ? "Saving…" : "Save destination"}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

function StateBadge({ label, healthy }: { label: string; healthy: boolean }) {
  return (
    <span
      className={`rounded-full border px-3 py-1 text-xs font-medium ${healthy ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-600" : "border-amber-500/30 bg-amber-500/10 text-amber-600"}`}
    >
      {label}
    </span>
  );
}
