import {
  AlertContainer,
  Button,
  Card,
  Checkbox,
  Input,
  Empty,
  ErrorState,
  SkeletonCard,
  Modal,
  SectionHeader,
  StatePill,
  showAlert,
} from "@gaulatti/bleecker";
import {
  ArrowDown,
  ArrowUp,
  KeyRound,
  Pencil,
  PlugZap,
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
import { AppPage } from "../components/AppPage";
import { ProgramFillerPanel } from "../components/ProgramFillerPanel";

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
  /** 'youtube' or 'custom'; null for a destination whose secret reference was typed by hand. */
  service: "youtube" | "custom" | null;
  ingestUrl: string | null;
  /** The last four characters of the key, or null for a short key or none. */
  keyLast4: string | null;
  keySetAt: string | null;
  retiredAt: string | null;
}

type DestinationService = "youtube" | "custom";
type DestinationDialog =
  | { kind: "add" }
  | { kind: "rename"; destination: CatalogDestination }
  | { kind: "key"; destination: CatalogDestination };

const YOUTUBE_INGEST_URL = "rtmps://a.rtmps.youtube.com:443/live2";
const INGEST_URL_PATTERN = /^rtmps?:\/\/[^\s/?#@]+\/[^\s?#]+$/i;

/** Inline checks for the add and replace-key forms; empty strings mean the field is fine. */
function validateDestinationForm(
  form: { service: DestinationService; name: string; ingestUrl: string; streamKey: string },
  options: { needsName: boolean; needsService: boolean; otherNames: string[] },
) {
  const errors = { name: "", ingestUrl: "", streamKey: "" };
  const name = form.name.trim();
  if (options.needsName) {
    if (!name) errors.name = "Enter a name.";
    else if (name.length > 100) errors.name = "Use at most 100 characters.";
    else if (options.otherNames.some((other) => other.trim().toLowerCase() === name.toLowerCase()))
      errors.name = "A destination with this name already exists.";
  }
  if (options.needsService && form.service === "custom" && !INGEST_URL_PATTERN.test(form.ingestUrl.trim())) {
    errors.ingestUrl = "Use an rtmp:// or rtmps:// address with a host and an application, for example rtmps://host/live.";
  }
  if (!form.streamKey) errors.streamKey = "Enter the stream key.";
  else if (/\s/.test(form.streamKey)) errors.streamKey = "A stream key has no spaces.";
  else if (form.streamKey.length > 512) errors.streamKey = "A stream key is at most 512 characters.";
  return errors;
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

/** The answer of the destination Test button. */
type DestinationTestResult = {
  result: "accepted" | "refused" | "unreachable";
  message?: string;
};

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
  // Retire is confirmed by name before it is sent (gaulatti/alcantara#349); Restore is direct.
  const [retireTarget, setRetireTarget] = useState<CatalogDestination | null>(null);
  const [dialog, setDialog] = useState<DestinationDialog | null>(null);
  const [form, setForm] = useState({
    service: "youtube" as DestinationService,
    name: "",
    ingestUrl: "",
    streamKey: "",
  });
  const [showKey, setShowKey] = useState(false);

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

  // The first load's failure has no data to show, so it gets an ErrorState with a retry (gaulatti/alcantara#349).
  const [loadFailed, setLoadFailed] = useState(false);
  useEffect(() => {
    if (permissionsLoading) return;
    setLoading(true);
    void load()
      .then(() => setLoadFailed(false))
      .catch((error) => {
        setLoadFailed(true);
        showAlert(handleApiError(error), "error");
      })
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

  const openDialog = (next: DestinationDialog) => {
    setForm({
      service: "youtube",
      name: next.kind === "rename" ? next.destination.displayName : "",
      ingestUrl: "",
      streamKey: "",
    });
    setShowKey(false);
    setDialog(next);
  };

  /** What the open dialog still needs; empty strings are fine. */
  const formErrors = useMemo(() => {
    if (!dialog || dialog.kind === "rename") return null;
    const target = dialog.kind === "key" ? dialog.destination : null;
    return validateDestinationForm(form, {
      needsName: dialog.kind === "add",
      // A destination added by hand has no service yet: replacing its key names one.
      needsService: dialog.kind === "add" || target?.service === null,
      otherNames: catalog.map((entry) => entry.displayName),
    });
  }, [dialog, form, catalog]);
  const formInvalid =
    dialog?.kind === "rename"
      ? !form.name.trim() || form.name.trim().length > 100
      : formErrors !== null && Boolean(formErrors.name || formErrors.ingestUrl || formErrors.streamKey);

  const saveDestination = async () => {
    /* v8 ignore next -- the save button is rendered only inside the open dialog, so saveDestination always runs with a dialog; this null guard is defensive. */
    if (!dialog) return;
    setBusyAction("catalog-save");
    try {
      if (dialog.kind === "rename") {
        await api.put(
          `/broadcast/destinations/${encodeURIComponent(dialog.destination.id)}`,
          { displayName: form.name.trim() },
        );
        showAlert("Destination renamed.", "success");
      } else if (dialog.kind === "add") {
        await api.post("/broadcast/destinations", {
          service: form.service,
          name: form.name.trim(),
          ...(form.service === "custom" ? { ingestUrl: form.ingestUrl.trim() } : {}),
          streamKey: form.streamKey,
        });
        showAlert("Destination added.", "success");
      } else {
        const legacy = dialog.destination.service === null;
        await api.put(
          `/broadcast/destinations/${encodeURIComponent(dialog.destination.id)}/key`,
          {
            streamKey: form.streamKey,
            ...(legacy
              ? {
                  service: form.service,
                  ...(form.service === "custom" ? { ingestUrl: form.ingestUrl.trim() } : {}),
                }
              : {}),
          },
        );
        showAlert("Key replaced. It applies from the next start.", "success");
      }
      // The key is dropped from the page as soon as it is sent.
      setForm((current) => ({ ...current, streamKey: "" }));
      setDialog(null);
      await load();
    } catch (error) {
      showAlert(handleApiError(error), "error");
    } finally {
      setBusyAction(null);
    }
  };

  /** Asks the ingest whether it accepts the saved key; nothing is sent but the handshake. */
  const testDestination = async (destination: CatalogDestination) => {
    setBusyAction(`test-${destination.id}`);
    try {
      const response = await api.post<DestinationTestResult>(
        `/broadcast/destinations/${encodeURIComponent(destination.id)}/test`,
      );
      const { result, message } = response.data;
      if (result === "accepted") {
        showAlert(`${destination.displayName} accepted the key.`, "success");
      } else {
        showAlert(
          `${destination.displayName} ${result === "refused" ? "refused the key" : "could not be reached"}: ${message ?? "no details"}`,
          "error",
        );
      }
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
    /* v8 ignore next -- the move buttons are disabled at both ends (Move up on the first row, Move down on the last), so this bounds guard is defensive and no UI path reaches it. */
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
      <AppPage>
        <div aria-busy="true" aria-label="Loading broadcasts" className="space-y-4">
          <SkeletonCard rows={3} />
          <SkeletonCard rows={4} />
        </div>
      </AppPage>
    );
  }
  if (loadFailed && !state) {
    return (
      <AppPage>
        <AlertContainer />
        <ErrorState
          title="Broadcasts could not be loaded"
          description="The executor state and destination catalog did not load. Nothing was changed."
          onRetry={() => {
            setLoading(true);
            void load()
              .then(() => setLoadFailed(false))
              .catch((error) => {
                setLoadFailed(true);
                showAlert(handleApiError(error), "error");
              })
              .finally(() => setLoading(false));
          }}
          retryLabel="Try again"
        />
      </AppPage>
    );
  }
  if (!canView) {
    return (
      <AppPage>
        <Card>
          <p className="text-sm text-text-secondary">
            You do not have broadcast.view permission.
          </p>
        </Card>
      </AppPage>
    );
  }

  return (
    <AppPage width="wide" className="space-y-6">
      <AlertContainer />
      <div className="flex flex-wrap items-start justify-between gap-4">
        <SectionHeader
          title="Broadcast destinations"
          description={`Destinations for the television leg of ${programId}. The desktop studio's Go live streams to the ones chosen there; Alcántara stores each stream key and never shows it again.`}
        />
        {canManage ? (
          <Button onClick={() => openDialog({ kind: "add" })}>
            <Plus size={15} /> Add destination
          </Button>
        ) : null}
      </div>

      {canManage ? (
        <Card>
          <h2 className="text-lg font-semibold text-text-primary">
            Destination catalog
          </h2>
          <p className="mt-1 text-sm text-text-secondary">
            Only catalog managers can add destinations and replace their keys.
            A key is written once and never shown again.
          </p>
          <div className="mt-4 space-y-3">
            {catalog.length === 0 ? (
              <Empty
                title="No destinations yet"
                description="Add a destination with its stream key. A Start needs at least one current destination."
                /* v8 ignore next -- this block renders only inside the canManage card, so canManage is always true here; the false arm cannot run. */
                action={canManage ? <Button onClick={() => openDialog({ kind: "add" })}>Add destination</Button> : undefined}
              />
            ) : null}
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
                  <p className="text-xs text-text-secondary">
                    {destination.service === "youtube"
                      ? "YouTube"
                      : destination.service === "custom"
                        ? `Custom RTMP(S) · ${destination.ingestUrl ?? ""}`
                        : "Secret reference (added by hand)"}
                  </p>
                  <p className="text-xs text-text-secondary">
                    Key {"••••"}
                    {destination.keyLast4 ?? ""}
                    {destination.keySetAt
                      ? ` · set ${new Date(destination.keySetAt).toLocaleDateString()}`
                      : ""}
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
                  onClick={() => openDialog({ kind: "rename", destination })}
                >
                  <Pencil size={14} /> Rename
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={Boolean(destination.retiredAt)}
                  onClick={() => openDialog({ kind: "key", destination })}
                >
                  <KeyRound size={14} />{" "}
                  {destination.service === null ? "Set key" : "Replace key"}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`Test ${destination.displayName}`}
                  disabled={Boolean(destination.retiredAt) || busyAction !== null}
                  onClick={() => void testDestination(destination)}
                >
                  <PlugZap size={14} />{" "}
                  {busyAction === `test-${destination.id}` ? "Testing…" : "Test"}
                </Button>
                <Button
                  size="sm"
                  variant={destination.retiredAt ? "ghost" : "destructive"}
                  onClick={() =>
                    destination.retiredAt
                      ? void setRetired(destination, false)
                      : setRetireTarget(destination)
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

      <section aria-labelledby="server-playout-title" className="space-y-4">
        <div>
          <h2 id="server-playout-title" className="text-lg font-semibold text-text-primary">
            Server playout (v2, not active)
          </h2>
          <p className="mt-1 text-sm text-text-secondary">
            Alana&apos;s server-side playout is not in use yet. Going live happens from the desktop
            studio&apos;s Go live; Confirm Start below does not put the desktop studio on air.
          </p>
        </div>
        <Card>
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-text-secondary">
                Executor state
              </p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <StatePill
                  label={`Requested ${state?.downstream.requestedState ?? "unknown"}`}
                  tone={executorTone(state?.downstream.requestedState)}
                />
                <StatePill
                  label={`Actual ${state?.downstream.actualState ?? "unknown"}`}
                  tone={
                    state?.downstream.requestedState === state?.downstream.actualState
                      ? executorTone(state?.downstream.actualState)
                      : "warn"
                  }
                  pulse={isRunning}
                />
                {state?.downstream.transition ? (
                  <StatePill label={state.downstream.transition} tone="warn" pulse />
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
      </section>

      <Modal
        isOpen={retireTarget !== null}
        onClose={() => setRetireTarget(null)}
        title="Confirm retire"
      >
        <div className="space-y-4">
          <p className="text-sm text-text-secondary">
            Retire {retireTarget?.displayName ?? "this destination"}? It leaves
            the catalog for new broadcasts. Active sessions are unchanged.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setRetireTarget(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={busyAction !== null}
              onClick={() => {
                const target = retireTarget;
                setRetireTarget(null);
                if (target) void setRetired(target, true);
              }}
            >
              Retire destination
            </Button>
          </div>
        </div>
      </Modal>

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
        isOpen={dialog !== null}
        onClose={() => setDialog(null)}
        title={
          dialog?.kind === "rename"
            ? "Rename destination"
            : dialog?.kind === "key"
              ? dialog.destination.service === null
                ? "Set key"
                : "Replace key"
              : "Add destination"
        }
      >
        <div className="space-y-4">
          {dialog?.kind === "key" ? (
            <p className="text-sm text-text-secondary">
              {dialog.destination.displayName}: the current key ends in {"••••"}
              {dialog.destination.keyLast4 ?? ""}. A new key applies from the next
              start; a broadcast already on air keeps the one it started with.
            </p>
          ) : null}
          {dialog?.kind === "add" ||
          (dialog?.kind === "key" && dialog.destination.service === null) ? (
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium text-text-primary">Service</legend>
              <div className="flex flex-wrap gap-2">
                {(["youtube", "custom"] as const).map((option) => (
                  <Button
                    key={option}
                    size="sm"
                    variant={form.service === option ? "primary" : "ghost"}
                    aria-pressed={form.service === option}
                    onClick={() => setForm((current) => ({ ...current, service: option }))}
                  >
                    {option === "youtube" ? "YouTube" : "Custom RTMP(S)"}
                  </Button>
                ))}
              </div>
              {form.service === "youtube" ? (
                <p className="text-xs text-text-secondary">
                  Ingest address: {YOUTUBE_INGEST_URL}
                </p>
              ) : (
                <label className="block text-sm font-medium text-text-primary">
                  Ingest URL
                  <Input
                    className="mt-1"
                    value={form.ingestUrl}
                    onChange={(event) =>
                      setForm((current) => ({ ...current, ingestUrl: event.target.value }))
                    }
                    placeholder="rtmps://ingest.example.com/live"
                  />
                  {formErrors?.ingestUrl && form.ingestUrl ? (
                    <span role="alert" className="mt-1 block text-xs text-red-500">
                      {formErrors.ingestUrl}
                    </span>
                  ) : null}
                </label>
              )}
            </fieldset>
          ) : null}
          {dialog?.kind === "add" || dialog?.kind === "rename" ? (
            <label className="block text-sm font-medium text-text-primary">
              Name
              <Input
                className="mt-1"
                value={form.name}
                onChange={(event) =>
                  setForm((current) => ({ ...current, name: event.target.value }))
                }
                placeholder="YouTube main channel"
              />
              {formErrors?.name && form.name ? (
                <span role="alert" className="mt-1 block text-xs text-red-500">
                  {formErrors.name}
                </span>
              ) : null}
            </label>
          ) : null}
          {dialog?.kind === "add" || dialog?.kind === "key" ? (
            <div>
              <label className="block text-sm font-medium text-text-primary">
                Stream key
                <Input
                  className="mt-1"
                  type={showKey ? "text" : "password"}
                  autoComplete="off"
                  value={form.streamKey}
                  onChange={(event) =>
                    setForm((current) => ({ ...current, streamKey: event.target.value }))
                  }
                />
              </label>
              <div className="mt-1 flex items-center gap-2">
                <Checkbox
                  checked={showKey}
                  onChange={(event) => setShowKey(event.target.checked)}
                  aria-label="Show key"
                />
                <span className="text-xs text-text-secondary">Show key</span>
              </div>
              {formErrors?.streamKey && form.streamKey ? (
                <span role="alert" className="mt-1 block text-xs text-red-500">
                  {formErrors.streamKey}
                </span>
              ) : null}
              <p className="mt-1 text-xs text-text-secondary">
                The key is saved to Secrets Manager by Alcántara and never shown again.
              </p>
            </div>
          ) : null}
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="ghost" onClick={() => setDialog(null)}>
              Cancel
            </Button>
            <Button
              onClick={() => void saveDestination()}
              disabled={busyAction !== null || formInvalid}
            >
              {busyAction === "catalog-save"
                ? "Saving…"
                : dialog?.kind === "rename"
                  ? "Rename"
                  : dialog?.kind === "key"
                    ? "Save key"
                    : "Add destination"}
            </Button>
          </div>
        </div>
      </Modal>
      <ProgramFillerPanel programId={programId} canManage={canManage} />
    </AppPage>
  );
}

/** Colour is not the only signal: the label carries the state in words (gaulatti/alcantara#349). */
function executorTone(state: string | undefined): "live" | "idle" | "warn" {
  if (state === "running") return "live";
  if (state === "stopped") return "idle";
  return "warn";
}
