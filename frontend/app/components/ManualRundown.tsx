import { TooltipButton } from "./BleeckerButtons";
import {
  AlertContainer,
  Button,
  Card,
  Empty,
  Input,
  LoadingSpinner,
  Modal,
  SectionHeader,
  Select,
  showAlert,
} from "@gaulatti/bleecker";
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  GripVertical,
  Tag,
  Unlink,
  Pause,
  Play,
  Plus,
  RefreshCcw,
  Repeat,
  SkipForward,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiUrl } from "../utils/apiBaseUrl";
import { TRANSITION_OPTIONS } from "../utils/transitionOptions";
import { useGlobalProgramId } from "../utils/globalProgram";
import { useSSE } from "../hooks/useSSE";
import type {
  FlightCue,
  FlightCueKind,
  FlightMixerChange,
  FlightRuntime,
  FlightSequence,
  InstantItem,
  Scene,
  SongCatalogItem,
} from "../models/broadcast";
import {
  createFlightCue,
  getFlightCueDisplayLabel,
} from "../utils/programFlightSequence";
import {
  activateFlightSequence,
  createFlightSequence,
  deactivateFlightSequence,
  deleteFlightSequence,
  fetchFlightSequences,
  goFlight,
  resetFlight,
  startFlight,
  stopFlight,
  updateFlightSequence,
} from "../services/flight";
import { RundownLibrary } from "./RundownLibrary";
import { cueFor, type LibraryEntry } from "../utils/rundownBuilder";
import {
  detachUse,
  groupRundown,
  insertCues,
  moveRow,
  removeUse,
  replaceUse,
  type RundownRow,
} from "../utils/recipeUses";
import {
  expandRecipe,
  fetchRecipes,
  type Recipe,
  type RecipeIssue,
} from "../services/recipes";
import { fetchAllMediaLabels } from "../services/mediaLabels";

const CUE_KIND_OPTIONS: { value: FlightCueKind; label: string }[] = [
  { value: "scene", label: "Switch scene" },
  { value: "playSong", label: "Play song" },
  { value: "stopSong", label: "Stop song" },
  { value: "instant", label: "Instant" },
  { value: "mixer", label: "Mixer" },
  { value: "wait", label: "Wait" },
  { value: "waitForSongEnd", label: "Wait for song end" },
  { value: "sceneUpdate", label: "Update scene" },
];

const MIXER_CHANNEL_OPTIONS: {
  value: Exclude<FlightMixerChange["channelId"], undefined>;
  label: string;
}[] = [
  { value: "main", label: "Main" },
  { value: "song", label: "Song" },
  { value: "instants", label: "Instants" },
  { value: "sceneInstant", label: "Scene Instant" },
  { value: "stream", label: "Stream" },
];

function extractErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}
export default function ManualRundown() {
  const [activeProgramId] = useGlobalProgramId();

  const [sequences, setSequences] = useState<FlightSequence[]>([]);
  const [activeSequenceId, setActiveSequenceId] = useState<number | null>(null);
  const [runtime, setRuntime] = useState<FlightRuntime | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const [scenes, setScenes] = useState<Scene[]>([]);
  const [songs, setSongs] = useState<SongCatalogItem[]>([]);
  const [instants, setInstants] = useState<InstantItem[]>([]);

  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  // gaulatti/alcantara#425: the program's recipes (null while the API has none), a use waiting for
  // the operator to accept its issues, and the use whose label is being changed.
  const [recipes, setRecipes] = useState<Recipe[] | null>(null);
  const [pendingUse, setPendingUse] = useState<{
    items: FlightCue[];
    issues: RecipeIssue[];
    title: string;
  } | null>(null);
  const [labelUse, setLabelUse] = useState<Extract<RundownRow, { kind: "use" }> | null>(null);
  const [mediaLabels, setMediaLabels] = useState<{ id: string; name: string }[] | null>(null);
  const [labelChoice, setLabelChoice] = useState("");
  const [newSequenceName, setNewSequenceName] = useState("");

  const activeSequence = useMemo(
    () => sequences.find((seq) => seq.id === activeSequenceId) ?? null,
    [sequences, activeSequenceId],
  );

  const loadSongs = useCallback(async () => {
    try {
      const res = await fetch(apiUrl("/songs?page=1&limit=1000"));
      if (!res.ok) return;
      const payload = await res.json();
      setSongs(Array.isArray(payload?.data) ? payload.data : []);
    } catch (err) {
      console.error("Failed to load songs:", err);
    }
  }, []);

  const loadInstants = useCallback(async () => {
    try {
      const res = await fetch(apiUrl("/instants"));
      if (!res.ok) return;
      const payload = await res.json();
      setInstants(Array.isArray(payload) ? payload : []);
    } catch (err) {
      console.error("Failed to load instants:", err);
    }
  }, []);

  // The rundown, what is running and the scenes, as the server has them.
  const readRundown = useCallback(
    async (cancelled: () => boolean) => {
      const [seqData, stateRes] = await Promise.all([
        fetchFlightSequences(activeProgramId),
        fetch(
          apiUrl(`/program/${encodeURIComponent(activeProgramId)}/state`),
        ).then((res) => (res.ok ? res.json() : null)),
      ]);

      if (cancelled()) return;

      setSequences(seqData.filter((sequence) => !sequence.scheduledAt));
      setActiveSequenceId(stateRes?.activeFlightSequenceId ?? null);

      const active = seqData.find(
        (seq: FlightSequence) => seq.id === stateRes?.activeFlightSequenceId,
      );
      setRuntime(
        active?.isRunning
          ? {
              sequenceId: active.id,
              activeIndex: active.items.findIndex(
                (cue) => cue.id === active.activeItemId,
              ),
              isRunning: active.isRunning,
              waitingForSongEnd: false,
              activeItemId: active.activeItemId,
              totalItems: active.items.length,
              loop: active.loop,
            }
          : null,
      );

      const entries = Array.isArray(stateRes?.scenes) ? stateRes.scenes : [];
      setScenes(
        entries
          .map((entry: any) => entry.scene)
          .filter((scene: unknown): scene is Scene => Boolean(scene)),
      );
    },
    [activeProgramId],
  );

  useEffect(() => {
    let cancelled = false;

    const bootstrap = async () => {
      setIsLoading(true);
      try {
        await readRundown(() => cancelled);
      } catch (err) {
        console.error("Failed to bootstrap flight mode:", err);
        showAlert("Failed to load rundown data.", "error");
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    };

    void bootstrap();
    void loadSongs();
    void loadInstants();

    return () => {
      cancelled = true;
    };
  }, [activeProgramId]);

  const handleSSE = useCallback(
    (data: any) => {
      if (!data || typeof data !== "object") return;

      if (data.type === "flight_update" && data.programId === activeProgramId) {
        setRuntime(data.runtime ?? null);
        if (
          typeof data.activeSequenceId === "number" ||
          data.activeSequenceId === null
        ) {
          setActiveSequenceId(data.activeSequenceId);
        }
        return;
      }

      if (
        data.type === "program_scenes_changed" &&
        data.programId === activeProgramId
      ) {
        const entries = Array.isArray(data.state?.scenes)
          ? data.state.scenes
          : [];
        setScenes(
          entries
            .map((entry: any) => entry.scene)
            .filter((scene: unknown): scene is Scene => Boolean(scene)),
        );
      }

      if (data.type === "scene_update" && data.scene) {
        setScenes((prev) =>
          prev.map((scene) =>
            scene.id === data.scene.id ? data.scene : scene,
          ),
        );
      }
    },
    [activeProgramId],
  );

  // Events sent while the stream was down are not sent again, and the backend may be a new one (alcantara#873): a
  // reconnect reads the rundown again.
  const streamConnectedFor = useRef<string | null>(null);
  const shownProgramRef = useRef(activeProgramId);
  shownProgramRef.current = activeProgramId;
  useSSE({
    url: apiUrl(`/program/${encodeURIComponent(activeProgramId)}/events`),
    onMessage: handleSSE,
    onConnectionStateChange: (connection) => {
      if (connection !== "connected") return;
      if (streamConnectedFor.current === activeProgramId)
        void readRundown(
          () => shownProgramRef.current !== activeProgramId,
        ).catch((err) =>
          console.error("Failed to reload the rundown:", err),
        );
      streamConnectedFor.current = activeProgramId;
    },
    enabled: true,
  });

  // Cue edits that are shown but not yet confirmed by the server, per sequence.
  // Each edit is built on the newest of these items, so a quick second edit (or
  // the next keystroke of a label) never starts from items an earlier edit
  // already changed. `confirmed` is the server's last answer, for a rollback.
  const unsavedItems = useRef(
    new Map<
      number,
      { items: FlightCue[]; edit: number; confirmed: FlightCue[] }
    >(),
  );
  const lastEdit = useRef(0);
  // Saves run one at a time in edit order, so the server applies them in the
  // order the operator made them.
  const saveQueue = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    let cancelled = false;
    setRecipes(null);
    fetchRecipes(activeProgramId)
      .then((loaded) => {
        if (!cancelled) setRecipes(loaded);
      })
      .catch((err) => {
        // Recipes are an addition: the rundown works without them.
        console.error("Failed to load recipes:", err);
      });
    return () => {
      cancelled = true;
    };
  }, [activeProgramId]);

  const latestItems = (sequence: FlightSequence) =>
    unsavedItems.current.get(sequence.id)?.items ?? sequence.items;

  const persistSequenceItems = useCallback(
    (sequence: FlightSequence, items: FlightCue[]) => {
      const edit = ++lastEdit.current;
      const confirmed =
        unsavedItems.current.get(sequence.id)?.confirmed ?? sequence.items;
      unsavedItems.current.set(sequence.id, { items, edit, confirmed });
      const show = (next: FlightCue[]) =>
        setSequences((prev) =>
          prev.map((seq) =>
            seq.id === sequence.id ? { ...seq, items: next } : seq,
          ),
        );
      show(items);
      // Only the newest edit's answer replaces what is shown: an older answer
      // never overwrites a newer local edit, which is still being saved.
      const isNewest = () =>
        unsavedItems.current.get(sequence.id)?.edit === edit;
      const save = saveQueue.current.then(async () => {
        try {
          const updated = await updateFlightSequence(
            activeProgramId,
            sequence.id,
            { items },
          );
          if (!isNewest()) {
            unsavedItems.current.get(sequence.id)!.confirmed = updated.items;
            return;
          }
          unsavedItems.current.delete(sequence.id);
          setSequences((prev) =>
            prev.map((seq) => (seq.id === sequence.id ? updated : seq)),
          );
        } catch (err) {
          console.error("Failed to save flight sequence:", err);
          showAlert(extractErrorMessage(err), "error");
          // A newer edit already includes this one and is still to be saved.
          if (!isNewest()) return;
          const { confirmed: last } = unsavedItems.current.get(sequence.id)!;
          unsavedItems.current.delete(sequence.id);
          show(last);
        }
      });
      saveQueue.current = save;
      return save;
    },
    [activeProgramId],
  );

  const handleCreateSequence = async () => {
    const name = newSequenceName.trim();
    if (!name) return;

    try {
      const created = await createFlightSequence(activeProgramId, {
        name,
        items: [],
      });
      setSequences((prev) => [...prev, created]);
      setNewSequenceName("");
      setIsCreateModalOpen(false);
      showAlert(`Sequence "${created.name}" created.`, "success");
    } catch (err) {
      showAlert(extractErrorMessage(err), "error");
    }
  };

  const handleDeleteSequence = async (sequenceId: number) => {
    if (!confirm("Delete this flight sequence?")) return;

    try {
      await deleteFlightSequence(activeProgramId, sequenceId);
      setSequences((prev) => prev.filter((seq) => seq.id !== sequenceId));
      if (activeSequenceId === sequenceId) {
        setActiveSequenceId(null);
        setRuntime(null);
      }
      showAlert("Sequence deleted.", "success");
    } catch (err) {
      showAlert(extractErrorMessage(err), "error");
    }
  };

  const handleActivateSequence = async (sequenceId: number) => {
    try {
      await activateFlightSequence(activeProgramId, sequenceId);
      setActiveSequenceId(sequenceId);
      setRuntime(null);
      showAlert("Sequence activated.", "success");
    } catch (err) {
      showAlert(extractErrorMessage(err), "error");
    }
  };

  const handleDeactivateSequence = async () => {
    try {
      await deactivateFlightSequence(activeProgramId);
      setActiveSequenceId(null);
      setRuntime(null);
      showAlert("Sequence deactivated.", "success");
    } catch (err) {
      showAlert(extractErrorMessage(err), "error");
    }
  };

  const handleToggleLoop = async () => {
    /* v8 ignore next -- callers render only while a sequence is active (lines 633, 660, 675, 692 gate them), so this guard is unreachable from the page */
    if (!activeSequence) return;

    try {
      const updated = await updateFlightSequence(
        activeProgramId,
        activeSequence.id,
        {
          loop: !activeSequence.loop,
        },
      );
      // The loop answer must not undo cue edits that are still being saved.
      setSequences((prev) =>
        prev.map((seq) =>
          seq.id === updated.id
            ? { ...updated, items: latestItems(updated) }
            : seq,
        ),
      );
    } catch (err) {
      showAlert(extractErrorMessage(err), "error");
    }
  };

  const handleAddCue = async (kind: FlightCueKind) => {
    /* v8 ignore next -- callers render only while a sequence is active (lines 633, 660, 675, 692 gate them), so this guard is unreachable from the page */
    if (!activeSequence) return;

    const cue = createFlightCue(kind);
    const items = [...latestItems(activeSequence), cue];
    await persistSequenceItems(activeSequence, items);
  };

  /** A song, clip or stop from the library, at the end (gaulatti/alcantara#425). */
  const handleAddLibraryEntry = async (entry: LibraryEntry) => {
    /* v8 ignore next -- callers render only while a sequence is active (lines 633, 660, 675, 692 gate them), so this guard is unreachable from the page */
    if (!activeSequence) return;
    const items = insertCues(latestItems(activeSequence), [cueFor(entry, false)]);
    await persistSequenceItems(activeSequence, items);
  };

  const songTitle = (songId: number) =>
    songs.find((item) => item.id === songId)?.title || `Song ${songId}`;

  /** One use of a recipe: its cues are added together, after the operator sees any issue. */
  const handleAddRecipeUse = async (recipeId: number, songId: number) => {
    /* v8 ignore next -- callers render only while a sequence is active (lines 633, 660, 675, 692 gate them), so this guard is unreachable from the page */
    if (!activeSequence) return;
    try {
      const { items, issues } = await expandRecipe(activeProgramId, recipeId, { songId });
      if (!items.length) {
        showAlert("The recipe has no steps to add.", "error");
        return;
      }
      if (issues.length) {
        setPendingUse({ items, issues, title: songTitle(songId) });
        return;
      }
      await persistSequenceItems(activeSequence, insertCues(latestItems(activeSequence), items));
    } catch (err) {
      showAlert(extractErrorMessage(err), "error");
    }
  };

  const confirmPendingUse = async () => {
    const use = pendingUse;
    setPendingUse(null);
    if (!activeSequence || !use) return;
    await persistSequenceItems(activeSequence, insertCues(latestItems(activeSequence), use.items));
  };

  const handleMoveRow = async (rowIndex: number, direction: "up" | "down") => {
    /* v8 ignore next -- callers render only while a sequence is active (lines 633, 660, 675, 692 gate them), so this guard is unreachable from the page */
    if (!activeSequence) return;
    const current = latestItems(activeSequence);
    const items = moveRow(current, rowIndex, direction);
    if (items !== current) await persistSequenceItems(activeSequence, items);
  };

  const handleDetachUse = async (useId: string) => {
    /* v8 ignore next -- callers render only while a sequence is active (lines 633, 660, 675, 692 gate them), so this guard is unreachable from the page */
    if (!activeSequence) return;
    await persistSequenceItems(activeSequence, detachUse(latestItems(activeSequence), useId));
  };

  const handleRemoveUse = async (useId: string) => {
    /* v8 ignore next -- callers render only while a sequence is active (lines 633, 660, 675, 692 gate them), so this guard is unreachable from the page */
    if (!activeSequence) return;
    await persistSequenceItems(activeSequence, removeUse(latestItems(activeSequence), useId));
  };

  const openLabelChange = (row: Extract<RundownRow, { kind: "use" }>) => {
    setLabelUse(row);
    setLabelChoice(row.cues[0]?.recipeUse?.params.labelId ?? "");
    if (mediaLabels === null)
      fetchAllMediaLabels<{ id: string; name: string }>()
        .then(setMediaLabels)
        .catch((err) => showAlert(extractErrorMessage(err), "error"));
  };

  /** Builds the use again with the chosen label, in place and with the same ids. */
  const applyLabelChange = async () => {
    const row = labelUse;
    setLabelUse(null);
    if (!activeSequence || !row) return;
    try {
      const { items } = await expandRecipe(
        activeProgramId,
        row.recipeId,
        { songId: row.songId, labelId: labelChoice || null },
        row.useId,
      );
      await persistSequenceItems(
        activeSequence,
        replaceUse(latestItems(activeSequence), row.useId, items),
      );
    } catch (err) {
      showAlert(extractErrorMessage(err), "error");
    }
  };

  const handleUpdateCue = async (cueId: string, patch: Partial<FlightCue>) => {
    /* v8 ignore next -- callers render only while a sequence is active (lines 633, 660, 675, 692 gate them), so this guard is unreachable from the page */
    if (!activeSequence) return;

    const items = latestItems(activeSequence).map((cue) =>
      cue.id === cueId ? ({ ...cue, ...patch } as FlightCue) : cue,
    );
    await persistSequenceItems(activeSequence, items);
  };

  const handleDeleteCue = async (cueId: string) => {
    /* v8 ignore next -- callers render only while a sequence is active (lines 633, 660, 675, 692 gate them), so this guard is unreachable from the page */
    if (!activeSequence) return;

    const items = latestItems(activeSequence).filter((cue) => cue.id !== cueId);
    await persistSequenceItems(activeSequence, items);
  };



  const sceneOptions = useMemo(
    () =>
      scenes.map((scene) => ({ value: String(scene.id), label: scene.name })),
    [scenes],
  );

  const songOptions = useMemo(
    () =>
      songs.map((song) => ({
        value: String(song.id),
        label: `${song.artist || "Unknown"} - ${song.title || "Untitled"}`,
      })),
    [songs],
  );

  const instantOptions = useMemo(
    () =>
      instants.map((instant) => ({
        value: String(instant.id),
        label: instant.name,
      })),
    [instants],
  );

  const activeCueIndex = runtime?.activeIndex ?? -1;

  return (
    // The console surface, like Timed blocks: the shared song picker reads its --console-* tokens from it.
    <div className="broadcast-console min-h-screen">
      <AlertContainer />
      <div className="mx-auto max-w-7xl p-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <SectionHeader
            title="Rundown"
            description={`Program: ${activeProgramId}`}
          />
          <Button
            type="button"
            onClick={() => setIsCreateModalOpen(true)}
            className="flex items-center gap-2 rounded bg-sea px-4 py-2 text-sm font-semibold text-zinc-950 hover:bg-sea/90"
          >
            <Plus size={16} />
            New rundown
          </Button>
        </div>

        {isLoading ? (
          <div className="flex h-64 items-center justify-center">
            <LoadingSpinner size="lg" />
          </div>
        ) : sequences.length === 0 ? (
          <Empty
            title="No rundowns yet"
            description="Create a rundown to start building your broadcast rundown."
            action={
              <Button
                type="button"
                onClick={() => setIsCreateModalOpen(true)}
                className="rounded bg-sea px-4 py-2 text-sm font-semibold text-zinc-950 hover:bg-sea/90"
              >
                Create rundown
              </Button>
            }
          />
        ) : (
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
            <div className="lg:col-span-2 space-y-4">
              <Card className="p-4">
                <div className="flex flex-wrap items-center gap-3">
                  <Select
                    value={
                      activeSequenceId === null ? "" : String(activeSequenceId)
                    }
                    onChange={(value) => {
                      const id = value ? Number(value) : null;
                      if (id !== activeSequenceId) {
                        setActiveSequenceId(id);
                        if (id !== null) {
                          void handleActivateSequence(id);
                        } else {
                          void handleDeactivateSequence();
                        }
                      }
                    }}
                    options={[
                      { value: "", label: "Choose a rundown..." },
                      ...sequences.map((seq) => ({
                        value: String(seq.id),
                        label: seq.name,
                      })),
                    ]}
                    className="min-w-[240px]"
                  />

                  {activeSequence && (
                    <>
                      {/* Bleecker's variant classes win over a passed className: the walk found every
                          button here in primary blue, Delete included. Use its variants instead. */}
                      <Button
                        type="button"
                        size="sm"
                        variant={activeSequence.loop ? "primary" : "secondary"}
                        aria-pressed={activeSequence.loop}
                        onClick={handleToggleLoop}
                      >
                        <Repeat size={14} />
                        {activeSequence.loop ? "Loop on" : "Loop off"}
                      </Button>

                      <Button
                        type="button"
                        size="sm"
                        variant="destructive"
                        onClick={() => handleDeleteSequence(activeSequence.id)}
                      >
                        <Trash2 size={14} />
                        Delete
                      </Button>
                    </>
                  )}
                </div>

                {activeSequence && (
                  <div className="mt-4 flex flex-wrap gap-2">
                    {CUE_KIND_OPTIONS.map((option) => (
                      <Button
                        key={option.value}
                        type="button"
                        size="sm"
                        variant="secondary"
                        onClick={() => handleAddCue(option.value)}
                      >
                        <Plus size={12} />
                        {option.label}
                      </Button>
                    ))}
                  </div>
                )}
                {activeSequence && (
                  <div className="mt-4">
                    <RundownLibrary
                      songs={songs}
                      clips={instants}
                      disabled={false}
                      onAdd={(entry) => void handleAddLibraryEntry(entry)}
                      recipes={recipes}
                      onAddRecipe={(recipeId, songId) =>
                        void handleAddRecipeUse(recipeId, songId)
                      }
                      footnote="Select an item and press Enter, double-click it, or tap Add, to add it at the end."
                    />
                  </div>
                )}
              </Card>

              {activeSequence ? (
                <Card className="divide-y divide-zinc-800">
                  {activeSequence.items.length === 0 ? (
                    <div className="p-8 text-center text-sm text-zinc-500">
                      No cues yet. Add one above.
                    </div>
                  ) : (
                    groupRundown(activeSequence.items).map((row, rowIndex, rows) =>
                      row.kind === "use" ? (
                        <UseRow
                          key={`${row.useId}-${row.start}`}
                          row={row}
                          recipeName={
                            recipes?.find((recipe) => recipe.id === row.recipeId)?.name ??
                            "Recipe"
                          }
                          songTitle={songTitle(row.songId)}
                          rowIndex={rowIndex}
                          rowCount={rows.length}
                          activeCueIndex={
                            runtime?.isRunning ? activeCueIndex : -1
                          }
                          describe={getFlightCueDisplayLabel}
                          onMove={(direction) => void handleMoveRow(rowIndex, direction)}
                          onDetach={() => void handleDetachUse(row.useId)}
                          onRemove={() => void handleRemoveUse(row.useId)}
                          onChangeLabel={() => openLabelChange(row)}
                        />
                      ) : (
                      ((cue, index) => (
                      <CueRow
                        key={cue.id}
                        cue={cue}
                        index={index}
                        total={activeSequence.items.length}
                        isActive={
                          index === activeCueIndex &&
                          Boolean(runtime?.isRunning)
                        }
                        isPending={
                          index > activeCueIndex && Boolean(runtime?.isRunning)
                        }
                        isCompleted={
                          index < activeCueIndex && Boolean(runtime?.isRunning)
                        }
                        scenes={scenes}
                        songs={songs}
                        instants={instants}
                        sceneOptions={sceneOptions}
                        songOptions={songOptions}
                        instantOptions={instantOptions}
                        onUpdate={(patch) => handleUpdateCue(cue.id, patch)}
                        onDelete={() => handleDeleteCue(cue.id)}
                        onMove={(direction) => void handleMoveRow(rowIndex, direction)}
                      />
                      ))(row.cue, row.index)
                      ),
                    )
                  )}
                </Card>
              ) : (
                <Card className="p-8 text-center text-sm text-zinc-500">
                  Select or create a sequence to edit cues.
                </Card>
              )}
            </div>

            <div className="space-y-4">
              <RuntimePanel
                activeSequence={activeSequence}
                runtime={runtime}
                instants={instants}
                onStart={() =>
                  void startFlight(activeProgramId)
                    .then(() => showAlert("Rundown started.", "success"))
                    .catch((err) =>
                      showAlert(extractErrorMessage(err), "error"),
                    )
                }
                onStop={() =>
                  void stopFlight(activeProgramId)
                    .then(() => showAlert("Rundown stopped.", "success"))
                    .catch((err) =>
                      showAlert(extractErrorMessage(err), "error"),
                    )
                }
                onGo={() =>
                  void goFlight(activeProgramId)
                    .then(() => showAlert("Advanced.", "success"))
                    .catch((err) =>
                      showAlert(extractErrorMessage(err), "error"),
                    )
                }
                onReset={() =>
                  void resetFlight(activeProgramId)
                    .then(() => showAlert("Rundown reset.", "success"))
                    .catch((err) =>
                      showAlert(extractErrorMessage(err), "error"),
                    )
                }
              />
            </div>
          </div>
        )}
      </div>

      <Modal
        isOpen={pendingUse !== null}
        onClose={() => setPendingUse(null)}
        title={`Add ${pendingUse?.title ?? "the song"} with issues?`}
      >
        <div className="space-y-4">
          <p className="text-sm text-zinc-300">
            The recipe can add this use, but it may not air as intended:
          </p>
          <ul className="list-disc space-y-1 pl-5 text-sm text-amber-300" aria-label="Recipe issues">
            {pendingUse?.issues.map((issue) => (
              <li key={issue.code + issue.message} data-code={issue.code}>
                {issue.message}
              </li>
            ))}
          </ul>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setPendingUse(null)}>
              Cancel
            </Button>
            <Button type="button" onClick={() => void confirmPendingUse()}>
              Add anyway
            </Button>
          </div>
        </div>
      </Modal>

      <Modal
        isOpen={labelUse !== null}
        onClose={() => setLabelUse(null)}
        title="Change the use's label"
      >
        <div className="space-y-4">
          <label className="block text-sm font-medium text-zinc-300">
            Media label for the bumper and the slideshow
            <select
              aria-label="Media label"
              className="mt-1 w-full rounded border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100"
              value={labelChoice}
              onChange={(event) => setLabelChoice(event.target.value)}
            >
              <option value="">The artist's label (or none)</option>
              {(mediaLabels ?? []).map((label) => (
                <option key={label.id} value={label.id}>
                  {label.name}
                </option>
              ))}
            </select>
          </label>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setLabelUse(null)}>
              Cancel
            </Button>
            <Button type="button" onClick={() => void applyLabelChange()}>
              Rebuild the use
            </Button>
          </div>
        </div>
      </Modal>

      <Modal
        isOpen={isCreateModalOpen}
        onClose={() => setIsCreateModalOpen(false)}
        title="Create rundown"
      >
        <div className="space-y-4">
          <label className="block text-sm font-medium text-zinc-300">
            Rundown name
            <Input
              value={newSequenceName}
              onChange={(e) => setNewSequenceName(e.target.value)}
              placeholder="e.g. Main show rundown"
              className="mt-1 w-full rounded border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-sea"
            />
          </label>
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              onClick={() => setIsCreateModalOpen(false)}
              className="rounded border border-zinc-700 bg-zinc-900 px-4 py-2 text-sm font-medium text-zinc-300 hover:bg-zinc-800"
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={() => void handleCreateSequence()}
              className="rounded bg-sea px-4 py-2 text-sm font-semibold text-zinc-950 hover:bg-sea/90"
            >
              Create
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

interface CueRowProps {
  cue: FlightCue;
  index: number;
  total: number;
  isActive: boolean;
  isPending: boolean;
  isCompleted: boolean;
  scenes: Scene[];
  songs: SongCatalogItem[];
  instants: InstantItem[];
  sceneOptions: { value: string; label: string }[];
  songOptions: { value: string; label: string }[];
  instantOptions: { value: string; label: string }[];
  onUpdate: (patch: Partial<FlightCue>) => void;
  onDelete: () => void;
  onMove: (direction: "up" | "down") => void;
}

function CueRow({
  cue,
  index,
  total,
  isActive,
  isPending,
  isCompleted,
  scenes,
  songs,
  instants,
  sceneOptions,
  songOptions,
  instantOptions,
  onUpdate,
  onDelete,
  onMove,
}: CueRowProps) {
  const statusClass = isActive
    ? "border-l-4 border-l-sea bg-sea/5"
    : isCompleted
      ? "border-l-4 border-l-zinc-600 opacity-60"
      : isPending
        ? "border-l-4 border-l-zinc-800"
        : "border-l-4 border-l-transparent";

  return (
    <div className={`p-4 ${statusClass}`}>
      <div className="flex items-start gap-3">
        <div className="mt-1 text-zinc-600">
          <GripVertical size={16} />
        </div>

        <div className="flex-1 space-y-3">
          <div className="flex flex-wrap items-center gap-3">
            <span className="flex h-6 w-6 items-center justify-center rounded-full bg-zinc-800 text-xs font-mono text-zinc-400">
              {index + 1}
            </span>

            <Select
              value={cue.kind}
              onChange={(value) => onUpdate({ kind: value as FlightCueKind })}
              options={CUE_KIND_OPTIONS}
              className="min-w-[160px]"
            />

            <Input
              value={cue.label ?? ""}
              onChange={(e) => onUpdate({ label: e.target.value || undefined })}
              placeholder="Label (optional)"
              className="min-w-[180px] flex-1 rounded border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-100 outline-none focus:border-sea"
            />

            {isActive && (
              <span className="flex items-center gap-1 rounded bg-sea/20 px-2 py-1 text-xs font-bold uppercase tracking-wider text-sea">
                <Play size={10} />
                Active
              </span>
            )}
          </div>

          <CueFields
            cue={cue}
            scenes={scenes}
            songs={songs}
            instants={instants}
            sceneOptions={sceneOptions}
            songOptions={songOptions}
            instantOptions={instantOptions}
            onUpdate={onUpdate}
          />
        </div>

        <div className="flex flex-col gap-1">
          <IconButton
            onClick={() => onMove("up")}
            disabled={index === 0}
            title="Move up"
          >
            <ArrowUp size={14} />
          </IconButton>
          <IconButton
            onClick={() => onMove("down")}
            disabled={index === total - 1}
            title="Move down"
          >
            <ArrowDown size={14} />
          </IconButton>
          <IconButton onClick={onDelete} variant="danger" title="Delete cue">
            <Trash2 size={14} />
          </IconButton>
        </div>
      </div>
    </div>
  );
}

interface CueFieldsProps {
  cue: FlightCue;
  scenes: Scene[];
  songs: SongCatalogItem[];
  instants: InstantItem[];
  sceneOptions: { value: string; label: string }[];
  songOptions: { value: string; label: string }[];
  instantOptions: { value: string; label: string }[];
  onUpdate: (patch: Partial<FlightCue>) => void;
}

function CueFields({
  cue,
  scenes,
  sceneOptions,
  songOptions,
  instantOptions,
  onUpdate,
}: CueFieldsProps) {
  switch (cue.kind) {
    case "scene":
      return (
        <div className="flex flex-wrap gap-3">
          <Select
            value={cue.sceneId !== undefined ? String(cue.sceneId) : ""}
            onChange={(value) =>
              onUpdate({ sceneId: value ? Number(value) : undefined })
            }
            options={[{ value: "", label: "Select scene..." }, ...sceneOptions]}
            className="min-w-[200px]"
          />
          <Select
            value={cue.transitionId || "cut"}
            onChange={(value) => onUpdate({ transitionId: value })}
            options={TRANSITION_OPTIONS}
            className="min-w-[160px]"
          />
        </div>
      );

    case "playSong":
      return (
        <Select
          value={cue.songId !== undefined ? String(cue.songId) : ""}
          onChange={(value) =>
            onUpdate({ songId: value ? Number(value) : undefined })
          }
          options={[{ value: "", label: "Select song..." }, ...songOptions]}
          className="min-w-[280px]"
        />
      );

    case "wait":
      return (
        <label className="flex items-center gap-2 text-sm text-zinc-300">
          Duration (ms)
          <Input
            type="number"
            min={0}
            step={100}
            value={cue.durationMs ?? 0}
            onChange={(e) => onUpdate({ durationMs: Number(e.target.value) })}
            className="w-32 rounded border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-100 outline-none focus:border-sea"
          />
        </label>
      );

    case "sceneUpdate":
      return (
        <SceneUpdateFields
          cue={cue}
          scenes={scenes}
          sceneOptions={sceneOptions}
          onUpdate={onUpdate}
        />
      );

    case "instant":
      return (
        <Select
          value={cue.instantId !== undefined ? String(cue.instantId) : ""}
          onChange={(value) =>
            onUpdate({ instantId: value ? Number(value) : undefined })
          }
          options={[
            { value: "", label: "Select instant..." },
            ...instantOptions,
          ]}
          className="min-w-[280px]"
        />
      );

    case "mixer":
      return <MixerCueFields cue={cue} onUpdate={onUpdate} />;

    case "stopSong":
    case "waitForSongEnd":
    default:
      return null;
  }
}

interface SceneUpdateFieldsProps {
  cue: FlightCue;
  scenes: Scene[];
  sceneOptions: { value: string; label: string }[];
  onUpdate: (patch: Partial<FlightCue>) => void;
}

function SceneUpdateFields({
  cue,
  scenes,
  sceneOptions,
  onUpdate,
}: SceneUpdateFieldsProps) {
  const [newComponentType, setNewComponentType] = useState("");

  const selectedScene = useMemo(
    () => scenes.find((scene) => scene.id === cue.sceneId) ?? null,
    [scenes, cue.sceneId],
  );

  const currentMetadata = useMemo(() => {
    if (!selectedScene?.metadata) return {};
    try {
      const parsed = JSON.parse(selectedScene.metadata);
      return isRecord(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }, [selectedScene]);

  const patch = useMemo(
    () =>
      cue.metadataPatch && isRecord(cue.metadataPatch) ? cue.metadataPatch : {},
    [cue.metadataPatch],
  );

  const effectiveMetadata = useMemo(
    () => (Object.keys(patch).length > 0 ? patch : currentMetadata),
    [currentMetadata, patch],
  );

  const updateEffectiveMetadata = (next: Record<string, unknown>) => {
    onUpdate({
      metadataPatch: Object.keys(next).length > 0 ? next : undefined,
    });
  };

  const updateComponentProp = (
    componentType: string,
    propKey: string,
    value: unknown,
  ) => {
    const next: Record<string, unknown> = { ...effectiveMetadata };
    const component = isRecord(next[componentType])
      ? { ...next[componentType] }
      : {};
    component[propKey] = value;
    next[componentType] = component;
    updateEffectiveMetadata(next);
  };

  const removeComponentProp = (componentType: string, propKey: string) => {
    const next: Record<string, unknown> = { ...effectiveMetadata };
    /* v8 ignore start -- the editor only removes a prop from a component it has rendered as an object, so this non-object arm is not reachable from the page */
    const component = isRecord(next[componentType])
      ? { ...next[componentType] }
      : {};
    /* v8 ignore stop */
    delete component[propKey];
    if (Object.keys(component).length === 0) {
      delete next[componentType];
    } else {
      next[componentType] = component;
    }
    updateEffectiveMetadata(next);
  };

  const addComponent = () => {
    const type = newComponentType.trim();
    /* v8 ignore next -- the Add button is disabled while the type exists, so this duplicate guard cannot be reached from the page */
    if (!type || effectiveMetadata[type]) return;
    const next = { ...effectiveMetadata, [type]: {} };
    updateEffectiveMetadata(next);
    setNewComponentType("");
  };

  const removeComponent = (componentType: string) => {
    const next = { ...effectiveMetadata };
    delete next[componentType];
    updateEffectiveMetadata(next);
  };

  return (
    <div className="space-y-3">
      <Select
        value={cue.sceneId !== undefined ? String(cue.sceneId) : ""}
        onChange={(value) =>
          onUpdate({ sceneId: value ? Number(value) : undefined })
        }
        options={[{ value: "", label: "Select scene..." }, ...sceneOptions]}
        className="min-w-[200px]"
      />

      {!selectedScene ? (
        <p className="text-sm text-zinc-500">
          Select a scene to edit its properties.
        </p>
      ) : (
        <div className="space-y-3 rounded border border-zinc-800 bg-zinc-900/50 p-3">
          <div className="flex items-center justify-between">
            <span className="text-xs text-zinc-500">
              {Object.keys(patch).length > 0
                ? "Editing effective metadata"
                : "Showing current scene metadata"}
            </span>
            <TooltipButton
              type="button"
              onClick={() => updateEffectiveMetadata(currentMetadata)}
              className="text-xs font-medium text-sea hover:text-sea/80"
            >
              Reset to scene metadata
            </TooltipButton>
          </div>

          <div className="flex items-center gap-2">
            <Input
              value={newComponentType}
              onChange={(e) => setNewComponentType(e.target.value)}
              placeholder="Component type (e.g. chyron)"
              className="flex-1 rounded border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-100 outline-none focus:border-sea"
            />
            <Button
              type="button"
              onClick={addComponent}
              disabled={
                !newComponentType.trim() ||
                Boolean(effectiveMetadata[newComponentType.trim()])
              }
              size="sm"
              variant="secondary"
            >
              <Plus size={12} />
              Add
            </Button>
          </div>

          {Object.keys(effectiveMetadata).length === 0 && (
            <p className="text-xs text-zinc-500">
              No properties yet. Add a component type above.
            </p>
          )}

          {Object.entries(effectiveMetadata).map(
            ([componentType, componentProps]) => {
              const props = isRecord(componentProps) ? componentProps : {};
              return (
                <ComponentPropsCard
                  key={componentType}
                  componentType={componentType}
                  props={props}
                  isNew={currentMetadata[componentType] === undefined}
                  onUpdateProp={(key, value) =>
                    updateComponentProp(componentType, key, value)
                  }
                  onRemoveProp={(key) =>
                    removeComponentProp(componentType, key)
                  }
                  onRemoveComponent={() => removeComponent(componentType)}
                />
              );
            },
          )}
        </div>
      )}
    </div>
  );
}

interface ComponentPropsCardProps {
  componentType: string;
  props: Record<string, unknown>;
  isNew: boolean;
  onUpdateProp: (key: string, value: unknown) => void;
  onRemoveProp: (key: string) => void;
  onRemoveComponent: () => void;
}

function ComponentPropsCard({
  componentType,
  props,
  isNew,
  onUpdateProp,
  onRemoveProp,
  onRemoveComponent,
}: ComponentPropsCardProps) {
  const [newPropKey, setNewPropKey] = useState("");
  const [newPropValue, setNewPropValue] = useState("");

  const addProp = () => {
    const key = newPropKey.trim();
    /* v8 ignore next -- the Add button is disabled while the property exists, so this duplicate guard cannot be reached from the page */
    if (!key || props[key] !== undefined) return;
    onUpdateProp(key, parsePropValue(newPropValue));
    setNewPropKey("");
    setNewPropValue("");
  };

  return (
    <div className="rounded border border-zinc-700 bg-zinc-900 p-3">
      <div className="mb-2 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="font-mono text-sm font-semibold text-sea">
            {componentType}
          </span>
          {isNew && (
            <span className="rounded bg-sea/10 px-1.5 py-0.5 text-[10px] font-bold uppercase text-sea">
              New
            </span>
          )}
        </div>
        <TooltipButton
          type="button"
          onClick={onRemoveComponent}
          title="Remove component"
          className="flex h-7 w-7 items-center justify-center rounded text-red-400 transition-colors hover:bg-red-950/30"
        >
          <Trash2 size={14} />
        </TooltipButton>
      </div>

      <div className="space-y-2">
        {Object.keys(props).length === 0 && (
          <p className="text-xs text-zinc-500">No properties yet.</p>
        )}

        {Object.entries(props).map(([key, value]) => (
          <PropRow
            key={key}
            propKey={key}
            value={value}
            onChange={(next) => onUpdateProp(key, next)}
            onRemove={() => onRemoveProp(key)}
          />
        ))}

        <div className="flex items-center gap-2 pt-1">
          <Input
            value={newPropKey}
            onChange={(e) => setNewPropKey(e.target.value)}
            placeholder="Property name"
            className="flex-1 rounded border border-zinc-800 bg-zinc-950 px-2 py-1 text-xs text-zinc-100 outline-none focus:border-sea"
          />
          <Input
            value={newPropValue}
            onChange={(e) => setNewPropValue(e.target.value)}
            placeholder="Value"
            className="flex-1 rounded border border-zinc-800 bg-zinc-950 px-2 py-1 text-xs text-zinc-100 outline-none focus:border-sea"
          />
          <Button
            type="button"
            onClick={addProp}
            disabled={
              !newPropKey.trim() || props[newPropKey.trim()] !== undefined
            }
            size="sm"
            variant="secondary"
          >
            Add
          </Button>
        </div>
      </div>
    </div>
  );
}

interface PropRowProps {
  propKey: string;
  value: unknown;
  onChange: (value: unknown) => void;
  onRemove: () => void;
}

function PropRow({ propKey, value, onChange, onRemove }: PropRowProps) {
  const type = inferValueType(value);

  return (
    <div className="flex items-center gap-2">
      <span
        className="w-32 truncate font-mono text-xs text-zinc-400"
        title={propKey}
      >
        {propKey}
      </span>

      {type === "boolean" ? (
        <TooltipButton
          type="button"
          onClick={() => onChange(!Boolean(value))}
          className={`rounded px-2 py-1 text-xs font-semibold ${
            value ? "bg-sea/20 text-sea" : "bg-zinc-800 text-zinc-400"
          }`}
        >
          {value ? "true" : "false"}
        </TooltipButton>
      ) : (
        <Input
          value={formatValueForInput(value)}
          onChange={(e) => onChange(parsePropValue(e.target.value))}
          className="flex-1 rounded border border-zinc-800 bg-zinc-950 px-2 py-1 text-xs text-zinc-100 outline-none focus:border-sea"
        />
      )}

      <TooltipButton
        type="button"
        onClick={onRemove}
        title="Remove property"
        className="flex h-7 w-7 items-center justify-center rounded text-red-400 transition-colors hover:bg-red-950/30"
      >
        <Trash2 size={12} />
      </TooltipButton>
    </div>
  );
}

function inferValueType(
  value: unknown,
): "string" | "number" | "boolean" | "other" {
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number") return "number";
  if (typeof value === "string") return "string";
  return "other";
}

function formatValueForInput(value: unknown): string {
  if (value === null) return "null";
  /* v8 ignore next -- property values come from parsed JSON, which has no undefined; the editor never passes one */
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

interface MixerCueFieldsProps {
  cue: FlightCue;
  onUpdate: (patch: Partial<FlightCue>) => void;
}

function MixerCueFields({ cue, onUpdate }: MixerCueFieldsProps) {
  const change = cue.mixerChange ?? {};

  return (
    <div className="flex flex-wrap items-center gap-3">
      <Select
        value={change.channelId ?? ""}
        onChange={(value) =>
          onUpdate({
            mixerChange: {
              ...change,
              channelId: value
                ? (value as FlightMixerChange["channelId"])
                : undefined,
            },
          })
        }
        options={[
          { value: "", label: "Select channel..." },
          ...MIXER_CHANNEL_OPTIONS,
        ]}
        className="min-w-[160px]"
      />

      {change.channelId && (
        <>
          <label className="flex items-center gap-2 text-sm text-zinc-300">
            Volume
            <Input
              type="number"
              min={0}
              max={1}
              step={0.05}
              value={change.volume ?? ""}
              onChange={(e) => {
                const nextVolume =
                  e.target.value === "" ? undefined : Number(e.target.value);
                onUpdate({
                  mixerChange: { ...change, volume: nextVolume },
                });
              }}
              placeholder="0-1"
              className="w-24 rounded border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-100 outline-none focus:border-sea"
            />
          </label>

          <Button
            type="button"
            onClick={() =>
              onUpdate({
                mixerChange: { ...change, muted: !change.muted },
              })
            }
            className={`rounded px-3 py-1.5 text-xs font-semibold ${
              change.muted
                ? "bg-red-600 text-white"
                : "border border-zinc-700 bg-zinc-900 text-zinc-300 hover:bg-zinc-800"
            }`}
          >
            {change.muted ? "Muted" : "Mute"}
          </Button>

          {change.channelId !== "main" && (
            <Button
              type="button"
              onClick={() =>
                onUpdate({
                  mixerChange: { ...change, solo: !change.solo },
                })
              }
              className={`rounded px-3 py-1.5 text-xs font-semibold ${
                change.solo
                  ? "bg-yellow-500 text-yellow-950"
                  : "border border-zinc-700 bg-zinc-900 text-zinc-300 hover:bg-zinc-800"
              }`}
            >
              {change.solo ? "Soloed" : "Solo"}
            </Button>
          )}
        </>
      )}
    </div>
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsePropValue(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed === "") return "";
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed === "null") return null;
  const num = Number(trimmed);
  if (!Number.isNaN(num)) return num;
  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
}

interface RuntimePanelProps {
  activeSequence: FlightSequence | null;
  runtime: FlightRuntime | null;
  instants: InstantItem[];
  onStart: () => void;
  onStop: () => void;
  onGo: () => void;
  onReset: () => void;
}

function RuntimePanel({
  activeSequence,
  runtime,
  instants,
  onStart,
  onStop,
  onGo,
  onReset,
}: RuntimePanelProps) {
  const isRunning = runtime?.isRunning ?? false;
  const activeCue =
    activeSequence && runtime
      ? activeSequence.items[runtime.activeIndex]
      : null;
  const nextCue =
    activeSequence && runtime
      ? activeSequence.items[runtime.activeIndex + 1]
      : null;

  return (
    <Card className="p-4">
      <h3 className="text-sm font-bold uppercase tracking-widest text-zinc-400">
        Runtime
      </h3>

      {!activeSequence ? (
        <p className="mt-4 text-sm text-zinc-500">No active rundown.</p>
      ) : (
        <>
          <div className="mt-4 space-y-3">
            <div>
              <div className="text-xs font-medium uppercase tracking-wider text-zinc-500">
                Active cue
              </div>
              <div className="mt-1 text-sm font-semibold text-zinc-100">
                {activeCue
                  ? getFlightCueDisplayLabel(activeCue, { instants })
                  : "—"}
              </div>
            </div>

            <div>
              <div className="text-xs font-medium uppercase tracking-wider text-zinc-500">
                Next cue
              </div>
              <div className="mt-1 text-sm text-zinc-300">
                {nextCue
                  ? getFlightCueDisplayLabel(nextCue, { instants })
                  : "—"}
              </div>
            </div>

            {runtime?.waitingForSongEnd && (
              <div className="rounded bg-amber-500/10 px-3 py-2 text-xs font-medium text-amber-300">
                Waiting for song to end…
              </div>
            )}

            <div className="text-xs text-zinc-500">
              Cue {runtime ? runtime.activeIndex + 1 : 0} of{" "}
              {activeSequence.items.length}
              {activeSequence.loop && " (looping)"}
            </div>
          </div>

          <div className="mt-6 grid grid-cols-2 gap-2">
            <Button
              type="button"
              // Variants, not className: Bleecker's variant classes win (Start and Stop both rendered blue).
              // Stopped, Start is the action to take; running, Stop is destructive and GO leads.
              variant={isRunning ? "destructive" : "primary"}
              onClick={isRunning ? onStop : onStart}
            >
              {isRunning ? <Pause size={16} /> : <Play size={16} />}
              {isRunning ? "Stop" : "Start"}
            </Button>

            <Button
              type="button"
              onClick={onGo}
              disabled={!activeSequence.items.length}
              variant={isRunning ? "primary" : "secondary"}
            >
              <SkipForward size={16} />
              GO
            </Button>

            <Button
              type="button"
              onClick={onReset}
              variant="secondary"
              className="col-span-2"
            >
              <RefreshCcw size={16} />
              Reset
            </Button>
          </div>
        </>
      )}
    </Card>
  );
}

interface IconButtonProps {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  variant?: "default" | "danger";
  title?: string;
}

function IconButton({
  children,
  onClick,
  disabled,
  variant = "default",
  title,
}: IconButtonProps) {
  return (
    <TooltipButton
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`flex h-7 w-7 items-center justify-center rounded transition-colors ${
        variant === "danger"
          ? "text-red-400 hover:bg-red-950/30"
          : "text-zinc-400 hover:bg-zinc-800"
      } disabled:opacity-30`}
    >
      {children}
    </TooltipButton>
  );
}

/**
 * One recipe use as one row (gaulatti/alcantara#425): the song and the recipe, its steps on demand,
 * and the actions that act on the whole use. Its cues stay ordinary cues in the rundown.
 */
export function UseRow({
  row,
  recipeName,
  songTitle,
  rowIndex,
  rowCount,
  activeCueIndex,
  describe,
  onMove,
  onDetach,
  onRemove,
  onChangeLabel,
  defaultOpen = false,
}: {
  row: Extract<RundownRow, { kind: "use" }>;
  recipeName: string;
  songTitle: string;
  rowIndex: number;
  rowCount: number;
  activeCueIndex: number;
  describe: (cue: FlightCue) => string;
  onMove: (direction: "up" | "down") => void;
  onDetach: () => void;
  onRemove: () => void;
  onChangeLabel: () => void;
  /** The steps start shown (the visual fixture). */
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const onAir = activeCueIndex >= row.start && activeCueIndex < row.end;
  const played = activeCueIndex >= row.end;
  return (
    <section
      aria-label={`Song: ${songTitle} · ${recipeName}`}
      data-recipe-use={row.useId}
      className={`p-4 ${onAir ? "bg-sea/10" : played ? "opacity-60" : ""}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          aria-expanded={open}
          aria-label={open ? "Hide the steps" : "Show the steps"}
          className="text-zinc-400 hover:text-zinc-100"
          onClick={() => setOpen((value) => !value)}
        >
          {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        </button>
        <span className="font-semibold text-zinc-100">Song: {songTitle}</span>
        <span className="text-xs text-zinc-400">· {recipeName} · {row.cues.length} steps</span>
        {onAir ? <span className="rounded bg-sea/20 px-2 py-0.5 text-xs text-sea">On air</span> : null}
        {row.partial ? (
          <span
            className="rounded bg-amber-500/20 px-2 py-0.5 text-xs text-amber-300"
            title="Hand edits split this use; detach it to keep editing its cues"
          >
            Partial use
          </span>
        ) : null}
        <span className="ml-auto flex items-center gap-1">
          <IconButton title="Move the use up" disabled={rowIndex === 0} onClick={() => onMove("up")}>
            <ArrowUp size={14} />
          </IconButton>
          <IconButton title="Move the use down" disabled={rowIndex === rowCount - 1} onClick={() => onMove("down")}>
            <ArrowDown size={14} />
          </IconButton>
          {!row.partial ? (
            <IconButton title="Change the label" onClick={onChangeLabel}>
              <Tag size={14} />
            </IconButton>
          ) : null}
          <IconButton title="Detach: edit these steps by hand" onClick={onDetach}>
            <Unlink size={14} />
          </IconButton>
          <IconButton title="Remove the use" variant="danger" onClick={onRemove}>
            <Trash2 size={14} />
          </IconButton>
        </span>
      </div>
      {open ? (
        <ol className="mt-3 space-y-1 pl-7 text-sm text-zinc-300" aria-label="Steps">
          {row.cues.map((cue, offset) => (
            <li
              key={cue.id}
              aria-current={row.start + offset === activeCueIndex ? "step" : undefined}
              className={row.start + offset === activeCueIndex ? "font-semibold text-sea" : ""}
            >
              {describe(cue)}
            </li>
          ))}
        </ol>
      ) : null}
    </section>
  );
}
