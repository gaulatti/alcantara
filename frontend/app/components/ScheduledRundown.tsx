import type { ReactNode } from "react";
// Button from BleeckerButtons directly: the same control the Bleecker alias resolves to, typed with tooltipSide.
import { Button, TooltipButton } from "./BleeckerButtons";
import {
  AlertContainer,
  Input,
  Modal,
  Select,
  showAlert,
} from "@gaulatti/bleecker";
import {
  AlertTriangle,
  CheckCircle2,
  Clock3,
  Mic2,
  Plus,
  Save,
  Trash2,
} from "lucide-react";
import { Link } from "react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "../components/BroadcastConsole.css";
import { RundownFillers } from "./RundownFillers";
import { RundownEventList, formatRundownDuration } from "./RundownEventList";
import { RundownLibrary } from "./RundownLibrary";
import { RundownTimeline } from "./RundownTimeline";
import {
  cueFor,
  insertCue,
  moveAnchor,
  snapSeconds,
  timelineLayout,
  type LibraryEntry,
} from "../utils/rundownBuilder";
import { rundownTiming } from "../utils/rundownTiming";
import { fixedStartClock, parseFixedStart } from "../utils/fixedStart";
import "./Rundown.css";
import { RadioLogGenerator } from "../components/RadioLogGenerator";
import { VoiceTrackRecorder } from "../components/VoiceTrackRecorder";
import { RundownAdvanced } from "./RundownAdvanced";
import type {
  FlightCue,
  FlightSequence,
  InstantItem,
  SongCatalogItem,
} from "../models/broadcast";
import {
  createFlightSequence,
  fetchFlightSequences,
  preflightFlightSequence,
  publishFlightSequence,
  updateFlightSequence,
  type PreflightEvent,
} from "../services/flight";
import { apiUrl } from "../utils/apiBaseUrl";
import { fetchProgramControl } from "../services/programControl";
import { useGlobalProgramId } from "../utils/globalProgram";

function nextLocalStart(): string {
  const date = new Date();
  date.setMinutes(date.getMinutes() + 5, 0, 0);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function formatClock(seconds: number): string {
  return `+${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

/** A check result as the page stores it: its issue and warning lists are always arrays, so rendering never reads undefined. */
function checkedResult<T extends { issues?: unknown; warnings?: unknown }>(
  result: T,
  forRevision: string,
): T & { issues: string[]; warnings: string[]; forRevision: string } {
  return {
    ...result,
    issues: Array.isArray(result.issues) ? (result.issues as string[]) : [],
    warnings: Array.isArray(result.warnings) ? (result.warnings as string[]) : [],
    forRevision,
  };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : "Request failed";
}

export default function ScheduledRundown({
  onDirtyChange,
  fixtureData,
  viewSwitch,
}: {
  onDirtyChange?: (dirty: boolean) => void;
  viewSwitch?: ReactNode;
  fixtureData?: {
    logs: FlightSequence[];
    songs: SongCatalogItem[];
    clips: InstantItem[];
  };
}) {
  const [programId] = useGlobalProgramId();
  const [rotationCount, setRotationCount] = useState<number | null>(null);
  const [logs, setLogs] = useState<FlightSequence[]>([]);
  const [songs, setSongs] = useState<SongCatalogItem[]>([]);
  const [clips, setClips] = useState<InstantItem[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [items, setItems] = useState<FlightCue[]>([]);
  const [startTime, setStartTime] = useState(nextLocalStart);
  const [busy, setBusy] = useState(false);
  // A preflight result belongs to one block revision. It is kept when it was
  // produced for the revision now selected (check and publish save first, which
  // bumps the revision) and cleared when the block or its revision moves on.
  const [preflight, setPreflight] = useState<{
    ready: boolean;
    issues: string[];
    warnings: string[];
    issueEvents?: Array<PreflightEvent | null>;
    warningEvents?: Array<PreflightEvent | null>;
    engine?: "ready" | "not-configured" | "disabled" | "not-radio";
    forRevision?: string;
  } | null>(null);
  // A block for a show whose radio is not set up, or is off, would air nothing (the rundown-building walk; D1).
  const radioNotSetUp =
    preflight?.engine === "not-configured" || preflight?.engine === "disabled";
  const [inspector, setInspector] = useState<"event" | "fillers" | "build">(
    "event",
  );
  const [selectedCueId, setSelectedCueId] = useState<string | null>(null);
  // What the operator is typing into an event's fixed start, until it is read (D3).
  const [fixedStartDraft, setFixedStartDraft] = useState<{
    cueId: string;
    text: string;
    error: string | null;
  } | null>(null);
  const [creating, setCreating] = useState(false);
  const inspectorRef = useRef<HTMLElement>(null);
  const [recordIndex, setRecordIndex] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const selected = logs.find((log) => log.id === selectedId) ?? null;
  const scheduledLogs = useMemo(
    () =>
      logs
        .filter((log) => log.scheduledAt)
        .sort(
          (a, b) => Date.parse(a.scheduledAt!) - Date.parse(b.scheduledAt!),
        ),
    [logs],
  );
  const dirty = selected
    ? JSON.stringify(items) !== JSON.stringify(selected.items)
    : false;

  useEffect(() => {
    onDirtyChange?.(dirty);
    return () => onDirtyChange?.(false);
  }, [dirty, onDirtyChange]);

  const load = useCallback(async () => {
    if (fixtureData) {
      setLogs(fixtureData.logs);
      setSongs(fixtureData.songs);
      setClips(fixtureData.clips);
      setSelectedId(fixtureData.logs[0]?.id ?? null);
      return;
    }
    const [sequences, songResponse, clipResponse, audioResponse] =
      await Promise.all([
        fetchFlightSequences(programId),
        fetch(apiUrl("/songs?page=1&limit=200")),
        fetch(apiUrl("/instants")),
        fetchProgramControl(programId, "audio-bus"),
      ]);
    if (!songResponse.ok || !clipResponse.ok)
      throw new Error("Radio library is unavailable");
    if (!audioResponse.ok)
      throw new Error("Continuous rotation is unavailable");
    const audio = await audioResponse.json();
    setRotationCount(audio.songSequence?.items?.length ?? 0);
    const songPayload = await songResponse.json();
    const clipPayload = await clipResponse.json();
    const allSongs: SongCatalogItem[] = Array.isArray(songPayload.data)
      ? [...songPayload.data]
      : [];
    for (let page = 2; page <= (songPayload.meta?.totalPages ?? 1); page++) {
      const response = await fetch(apiUrl(`/songs?page=${page}&limit=200`));
      if (!response.ok) throw new Error("Radio library is unavailable");
      const payload = await response.json();
      allSongs.push(...payload.data);
    }
    setLogs(sequences);
    setSongs(allSongs);
    setClips(Array.isArray(clipPayload) ? clipPayload : []);
    setSelectedId((current) =>
      current && sequences.some((log) => log.id === current)
        ? current
        : (sequences.find((log) => log.scheduledAt)?.id ?? null),
    );
  }, [programId, fixtureData]);

  useEffect(() => {
    void load().catch((cause) => setError(message(cause)));
  }, [load]);
  useEffect(() => {
    setItems(selected?.items ?? []);
    const current = `${selectedId}:${selected?.revision}`;
    setPreflight((result) => (result?.forRevision === current ? result : null));
    setSelectedCueId(null);
  }, [selectedId, selected?.revision]);

  const create = async () => {
    setError(null);
    const scheduledAt = new Date(startTime);
    if (
      !Number.isFinite(scheduledAt.getTime()) ||
      scheduledAt.getTime() <= Date.now()
    ) {
      setError("Choose a future start time.");
      return;
    }
    setBusy(true);
    try {
      const created = await createFlightSequence(programId, {
        name: `Radio · ${scheduledAt.toLocaleString()}`,
        scheduledAt: scheduledAt.toISOString(),
        items: [],
      });
      await load();
      setSelectedId(created.id);
      setCreating(false);
      showAlert("Draft rundown created.", "success");
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  };

  const save = async (nextItems = items): Promise<FlightSequence> => {
    /* v8 ignore next -- save is reached only from the Save button (enabled only while dirty, and edits need a selected log) and from the check and publish paths, which run only with a selected log; this guard is defensive. */
    if (!selected) throw new Error("Select a radio log");
    setBusy(true);
    setError(null);
    try {
      const updated = await updateFlightSequence(programId, selected.id, {
        items: nextItems,
        revision: selected.revision,
      });
      setLogs((current) =>
        current.map((log) => (log.id === updated.id ? updated : log)),
      );
      setItems(updated.items);
      setPreflight(null);
      showAlert("Rundown saved.", "success");
      return updated;
    } catch (cause) {
      setError(message(cause));
      throw cause;
    } finally {
      setBusy(false);
    }
  };

  const check = async () => {
    /* v8 ignore next -- check() is reached only through the Check button, which is disabled while no log is selected (line 481); this guard is defensive. */
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      const updated = dirty ? await save() : selected;
      const result = await preflightFlightSequence(programId, updated.id);
      setPreflight(checkedResult(result, `${updated.id}:${updated.revision}`));
      if (result.ready) {
        const notSetUp =
          result.engine === "not-configured" || result.engine === "disabled";
        // The warnings sit under the block actions; the toast says they are there (B2).
        const others = result.warnings.length - (notSetUp ? 1 : 0);
        const more =
          others > 0
            ? ` ${others} warning${others === 1 ? "" : "s"}: check before air.`
            : "";
        showAlert(
          notSetUp
            ? `All scheduled audio is available, but radio isn't set up for this show: it won't air until it is.${more}`
            : `All scheduled audio is available.${more}`,
          notSetUp || others > 0 ? "warning" : "success",
        );
      }
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  };

  const publish = async (checked?: FlightSequence) => {
    /* v8 ignore next -- publish() is reached only when canPublish holds (it requires a selected log), or from the overrun dialog that canPublish opened; this guard is defensive. */
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      const updated = checked ?? (dirty ? await save() : selected);
      const published = await publishFlightSequence(
        programId,
        updated.id,
        updated.revision,
      );
      setLogs((current) =>
        current.map((log) => (log.id === published.id ? published : log)),
      );
      // Read the published revision's check again rather than assume it: its warnings, and whether the show's
      // radio is set up, still hold after publishing.
      let after: Awaited<ReturnType<typeof preflightFlightSequence>> | null;
      try {
        after = (await preflightFlightSequence(programId, published.id)) ?? null;
      } catch {
        after = null;
      }
      setPreflight(
        after
          ? checkedResult(after, `${published.id}:${published.revision}`)
          : null,
      );
      if (after?.engine === "not-configured" || after?.engine === "disabled")
        showAlert(
          "Rundown published, but radio isn't set up for this show: it won't air until it is.",
          "warning",
        );
      else showAlert("Rundown published for automatic start.", "success");
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  };

  // Publishing a block that overruns a fixed start asks first, naming the loss.
  const [overrunAsk, setOverrunAsk] = useState(false);
  const requestPublish = () => {
    if (layout.overrunMs > 0) setOverrunAsk(true);
    else void publish();
  };

  const updateItem = (index: number, patch: Partial<FlightCue>) => {
    setPreflight(null);
    setItems((current) =>
      current.map((item, row) =>
        row === index ? { ...item, ...patch } : item,
      ),
    );
  };
  // Library entries land as the same cues the forms created (#299).
  const add = (entry: LibraryEntry, index?: number) => {
    setPreflight(null);
    const cue = cueFor(entry, items.length === 0);
    setItems((current) => insertCue(current, cue, index, activeIndex));
    setSelectedCueId(cue.id);
    setInspector("event");
  };

  const activeIndex = selected?.isRunning
    ? selected.items.findIndex((item) => item.id === selected.activeItemId)
    : selected?.lastStartedAt
      ? selected.items.length - 1
      : -1;
  const recordCue = recordIndex === null ? null : items[recordIndex];
  const recordSong = recordCue?.songId
    ? songs.find((song) => song.id === recordCue.songId)
    : null;

  const timing = rundownTiming(items, songs);
  const layout = timelineLayout(items, songs);
  const revealInspector = () => {
    if (window.matchMedia("(max-width: 760px)").matches) {
      requestAnimationFrame(() =>
        inspectorRef.current?.scrollIntoView({ block: "start" }),
      );
    }
  };
  const editIndex = items.findIndex((cue) => cue.id === selectedCueId);
  const editCue = items[editIndex];
  const fixedDraft =
    editCue && fixedStartDraft?.cueId === editCue.id ? fixedStartDraft : null;
  const nextScheduledAt = selected
    ? (scheduledLogs.find(
        (log) => Date.parse(log.scheduledAt!) > Date.parse(selected.scheduledAt!),
      )?.scheduledAt ?? null)
    : null;
  const commitFixedStart = (cueId: string, text: string) => {
    if (!text.trim()) {
      setFixedStartDraft(null);
      updateItem(editIndex, { clockOffsetSeconds: undefined });
      return;
    }
    const result = parseFixedStart(text, selected!.scheduledAt!, nextScheduledAt);
    if (!result.ok) {
      setFixedStartDraft({ cueId, text, error: result.message });
      return;
    }
    setFixedStartDraft(null);
    updateItem(editIndex, { clockOffsetSeconds: result.seconds });
  };
  const editLocked = editIndex <= activeIndex;
  const editable =
    !!selected && (!selected.lastStartedAt || selected.isRunning);
  const canPublish =
    !!selected &&
    !busy &&
    !fixtureData &&
    !selected.lastStartedAt &&
    !selected.isRunning;
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey)) return;
      event.preventDefault();
      if (selected && !busy && !fixtureData) void check();
    };
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  });
  const gapMs = timing.reduce(
    (sum, row, index) =>
      sum + (items[index].kind === "stopSong" ? 0 : (row.gapMs ?? 0)),
    0,
  );
  const unknown = timing.filter((row) => row.durationMs == null).length;
  const remove = () => {
    setPreflight(null);
    setItems((current) => {
      const next = current.filter((cue) => cue.id !== selectedCueId);
      if (next[0]) next[0] = { ...next[0], clockOffsetSeconds: 0 };
      return next;
    });
    setSelectedCueId(null);
  };
  return (
    <main className="broadcast-console rundown-workspace">
      <AlertContainer />
      <header className="rundown-toolbar">
        <div className="rundown-toolbar-title">
          <h1>Rundown</h1>
          {viewSwitch}
        </div>
        <div className="rundown-hour-select">
          <div>
            <Select
              aria-label="Scheduled block"
              value={selectedId ? String(selectedId) : ""}
              disabled={busy || dirty}
              onChange={(value) => setSelectedId(Number(value))}
              options={[
                { value: "", label: "Choose a block" },
                ...scheduledLogs.map((log) => ({
                  value: String(log.id),
                  label: `${new Date(log.scheduledAt!).toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false })} · ${log.isRunning ? "On air" : log.lastStartedAt ? "Aired" : log.publishedAt ? "Published" : "Draft"}`,
                })),
              ]}
            />
          </div>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            disabled={busy || dirty || !!fixtureData}
            onClick={() => setCreating(true)}
          >
            <Plus size={14} /> New block
          </Button>
        </div>
      </header>
      {error && (
        <div role="alert" className="rundown-errors">
          {error}
        </div>
      )}
      <section
        className="rundown-continuous"
        aria-label="Continuous filler rotation"
      >
        <span className="console-eyebrow">Fillers</span>
        <span className="rundown-continuous-count">
          {rotationCount === null ? "" : `${rotationCount} saved songs`}
        </span>
        <span className="console-eyebrow">24/7</span>
        <Link to="/control" className="rundown-continuous-link max-sm:inline-flex max-sm:min-h-11 max-sm:items-center max-sm:-my-[13px]">Rotation ▸</Link>
      </section>
      <div className="rundown-desk">
        <aside className="rundown-library-column" aria-label="Song and clip library">
          <RundownLibrary
            songs={songs}
            clips={clips}
            disabled={busy || !editable || !selected}
            onAdd={(entry) => add(entry)}
          />
        </aside>
        <section className="rundown-sequence" aria-label="Timed block rundown">
          <div className="rundown-sequence-heading">
            <div>
              <h2>Block events</h2>
              <p>
                {selected
                  ? `${selected.isRunning ? "ON AIR" : selected.lastStartedAt ? "AIRED / INTERRUPTED" : selected.publishedAt ? "PUBLISHED" : "DRAFT"} · Revision ${selected.revision} · ${items.length} events${dirty ? " · Unsaved changes" : ""}`
                  : ""}
              </p>
              {!!selected && (
                <p>
                  {
                    items.filter(
                      (cue) => cue.isFiller && cue.kind === "playSong",
                    ).length
                  }{" "}
                  fillers · {formatRundownDuration(gapMs)} unfilled
                  {unknown ? ` · ${unknown} unknown durations` : ""}
                </p>
              )}
            </div>
            <div className="rundown-actions">
              {dirty && (
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => {
                    setItems(selected!.items);
                    setPreflight(null);
                  }}
                >
                  Discard
                </Button>
              )}
              <Button
                size="xs"
                variant="secondary"
                disabled={!dirty || busy || !editable || !!fixtureData}
                onClick={() => void save().catch(() => {})}
              >
                <Save size={13} /> Save
              </Button>
              <Button
                size="xs"
                variant="secondary"
                disabled={!selected || busy || !!fixtureData}
                onClick={() => void check()}
              >
                Check
              </Button>
              <Button
                size="xs"
                variant="secondary"
                disabled={!selected}
                onClick={() => setInspector("fillers")}
              >
                Fill gaps
              </Button>
              <Button
                size="xs"
                variant="secondary"
                disabled={!canPublish}
                onClick={() => requestPublish()}
              >
                Publish
              </Button>
            </div>
          </div>
          {/* Check's result sits under the actions that produced it, not below the whole log. */}
          {preflight && (
            <div className="rundown-sequence-heading" role="status">
              {preflight.ready && radioNotSetUp ? (
                <span className="console-status" data-tone="warning">
                  <AlertTriangle size={13} /> Audio checked · radio not set up
                </span>
              ) : preflight.ready ? (
                <span className="console-status" data-tone="ready">
                  <CheckCircle2 size={13} /> Audio checked · ready for air
                </span>
              ) : (
                <div>
                  <span className="console-status" data-tone="warning">
                    <AlertTriangle size={13} /> Needs attention
                  </span>
                  <ul>
                    {preflight.issues.map((issue, index) => (
                      <li key={issue}>
                        <PreflightLine
                          text={issue}
                          event={preflight.issueEvents?.[index]}
                        />
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {preflight.warnings.length > 0 && (
                <div>
                  <span className="console-status" data-tone="warning">
                    <AlertTriangle size={13} /> Check before air
                  </span>
                  <ul aria-label="Preflight warnings">
                    {preflight.warnings.map((warning, index) => (
                      <li key={warning}>
                        <PreflightLine
                          text={warning}
                          event={preflight.warningEvents?.[index]}
                        />
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
          {selected && (
            <div className="rundown-builder">
              <RundownTimeline
                items={items}
                songs={songs}
                clips={clips}
                scheduledAt={selected.scheduledAt!}
                activeIndex={activeIndex}
                selectedCueId={selectedCueId}
                disabled={busy || !editable}
                onSelect={(id) => {
                  setSelectedCueId(id);
                  setInspector("event");
                  revealInspector();
                }}
                onDropEntry={(entry, index) => add(entry, index)}
                onMoveAnchor={(index, seconds) => {
                  setPreflight(null);
                  setItems((current) => moveAnchor(current, index, seconds));
                }}
              />
              <div className="rundown-key" aria-label="Timeline key">
                <span><i className="rundown-key-event" />event</span>
                <span><i className="rundown-key-fixed" />fixed start</span>
                <span><i className="rundown-key-overrun" />overrun</span>
                <span><i className="rundown-key-gap" />gap</span>
              </div>
            </div>
          )}
          {selected ? (
            <RundownEventList
              items={items}
              songs={songs}
              clips={clips}
              scheduledAt={selected.scheduledAt!}
              activeIndex={activeIndex}
              selectedCueId={selectedCueId}
              onSelect={(id) => {
                setSelectedCueId(id);
                setInspector("event");
                revealInspector();
              }}
            />
          ) : (
            <div className="rundown-empty">
              <Clock3 size={28} className="mx-auto mb-3" />
              <strong>No timed block selected</strong>
            </div>
          )}
        </section>
        <aside
          ref={inspectorRef}
          className="rundown-inspector"
          aria-label="Rundown inspector"
        >
          <div
            className="rundown-inspector-tabs"
            role="group"
            aria-label="Rundown tools"
          >
            {(
              [
                ["event", "Event"],
                ["fillers", "Fillers"],
                ["build", "Build"],
              ] as const
            ).map(([id, label]) => (
              <TooltipButton
                key={id}
                type="button"
                aria-pressed={inspector === id}
                onClick={() => setInspector(id)}
              >
                {label}
              </TooltipButton>
            ))}
          </div>
          <div className="rundown-inspector-body">
            {inspector === "fillers" && (
              <RundownFillers
                programId={programId}
                rundown={fixtureData ? null : selected}
                fixtureLabels={
                  fixtureData
                    ? [{ id: "music", name: "Music rotation" }]
                    : undefined
                }
                items={items}
                onFilled={(filled) => {
                  setItems(filled);
                  setPreflight(null);
                  setSelectedCueId(null);
                }}
              />
            )}
            {inspector === "build" && (
              <RadioLogGenerator
                programId={programId}
                log={fixtureData ? null : selected}
                fixtureLabels={
                  fixtureData
                    ? [{ id: "music", name: "Music rotation" }]
                    : undefined
                }
                onGenerated={(generated) => {
                  setItems(generated);
                  setPreflight(null);
                  setSelectedCueId(null);
                }}
              />
            )}
            {inspector === "event" &&
              (editCue ? (
                <>
                  <span className="console-eyebrow">
                    Event {String(editIndex + 1).padStart(2, "0")}
                    {editCue.isFiller ? " · Filler" : ""}
                    {editLocked ? " · Locked" : ""}
                  </span>
                  <h2 className="mt-2">
                    {editCue.kind === "playSong"
                      ? "Music event"
                      : editCue.kind === "instant"
                        ? "Audio clip"
                        : "Stop program audio"}
                  </h2>
                  {editCue.kind === "playSong" && (
                    <label>
                      Catalog song
                      <Select
                        aria-label="Event song"
                        disabled={editLocked || busy}
                        value={editCue.songId ? String(editCue.songId) : ""}
                        onChange={(value) =>
                          updateItem(editIndex, { songId: Number(value) })
                        }
                        options={[
                          { value: "", label: "Choose song" },
                          ...songs.map((song) => ({
                            value: String(song.id),
                            label: `${song.artist} — ${song.title}${song.enabled ? "" : " (disabled)"}`,
                          })),
                        ]}
                      />
                    </label>
                  )}
                  {editCue.kind === "instant" && (
                    <>
                      <label>
                        Audio clip
                        <Select
                          aria-label="Event clip"
                          disabled={editLocked || busy}
                          value={
                            editCue.instantId ? String(editCue.instantId) : ""
                          }
                          onChange={(value) =>
                            updateItem(editIndex, { instantId: Number(value) })
                          }
                          options={[
                            { value: "", label: "Choose clip" },
                            ...clips.map((clip) => ({
                              value: String(clip.id),
                              label: clip.name,
                            })),
                          ]}
                        />
                      </label>
                      <label>
                        Clip duration (seconds)
                        <Input
                          aria-label="Clip duration"
                          type="number"
                          min="1"
                          value={
                            editCue.durationMs ? editCue.durationMs / 1000 : ""
                          }
                          disabled={editLocked || busy}
                          onChange={(event) =>
                            updateItem(editIndex, {
                              durationMs: event.target.value
                                ? Number(event.target.value) * 1000
                                : undefined,
                            })
                          }
                        />
                      </label>
                    </>
                  )}
                  <label>
                    Fixed start (clock time, +mm:ss or seconds)
                    <Input
                      aria-label="Fixed start"
                      type="text"
                      value={
                        fixedDraft?.text ??
                        (editCue.clockOffsetSeconds === undefined
                          ? ""
                          : formatClock(editCue.clockOffsetSeconds))
                      }
                      aria-invalid={fixedDraft?.error ? true : undefined}
                      disabled={editLocked || editIndex === 0 || busy}
                      placeholder="Follow previous event"
                      onChange={(event) =>
                        setFixedStartDraft({
                          cueId: editCue.id,
                          text: event.target.value,
                          error: null,
                        })
                      }
                      onBlur={(event) => {
                        if (fixedDraft)
                          commitFixedStart(editCue.id, event.currentTarget.value);
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" && fixedDraft)
                          commitFixedStart(editCue.id, event.currentTarget.value);
                      }}
                    />
                  </label>
                  {fixedDraft?.error && (
                    <p className="rundown-inspector-note" role="alert">
                      {fixedDraft.error}
                    </p>
                  )}
                  {editIndex > 0 && (
                    <Button
                      size="xs"
                      variant="ghost"
                      disabled={editLocked || busy}
                      onClick={() =>
                        updateItem(editIndex, {
                          clockOffsetSeconds:
                            editCue.clockOffsetSeconds === undefined
                              ? snapSeconds(
                                  (timing[editIndex].startMs ?? 0) / 1000,
                                )
                              : undefined,
                        })
                      }
                    >
                      {editCue.clockOffsetSeconds === undefined
                        ? "Pin its start here"
                        : "Follow the previous event"}
                    </Button>
                  )}
                  <p className="rundown-inspector-note">
                    {editCue.clockOffsetSeconds === undefined
                      ? "Follows the previous event. The start in the log is estimated from catalog duration."
                      : `${fixedStartClock(selected!.scheduledAt!, editCue.clockOffsetSeconds)} · ${formatClock(editCue.clockOffsetSeconds)} · Starts on time and cuts the preceding filler.`}
                  </p>
                  {editCue.voiceTrackInstantId && (
                    <p className="rundown-inspector-note">
                      Voice track #{editCue.voiceTrackInstantId} · music at{" "}
                      {Math.round((editCue.voiceDuckGain ?? 0.35) * 100)}%
                    </p>
                  )}
                  <RundownAdvanced
                    cue={editCue}
                    disabled={editLocked || busy}
                    onChange={(patch) => updateItem(editIndex, patch)}
                  />
                  <div className="rundown-actions mt-5">
                    {editCue.kind === "playSong" &&
                      songs.some((song) => song.id === editCue.songId) && (
                        <Button
                          size="xs"
                          variant="secondary"
                          tooltipSide="bottom"
                          disabled={editLocked || busy || !!fixtureData}
                          onClick={() => setRecordIndex(editIndex)}
                        >
                          <Mic2 size={13} /> Record voice
                        </Button>
                      )}
                    <Button
                      size="xs"
                      variant="destructive"
                      tooltipSide="bottom"
                      disabled={editLocked || busy}
                      onClick={remove}
                    >
                      <Trash2 size={13} /> Remove
                    </Button>
                  </div>
                </>
              ) : (
                <>
                  <h2 className="mt-2">Select an event</h2>
                </>
              ))}
          </div>
        </aside>
      </div>
      <Modal
        isOpen={creating}
        onClose={() => setCreating(false)}
        title="New timed block"
      >
        <label className="block text-sm">
          Scheduled start
          <Input
            aria-label="Scheduled start"
            type="datetime-local"
            step="60"
            value={startTime}
            onChange={(event) => setStartTime(event.target.value)}
          />
        </label>
        <p className="my-3 text-xs text-text-secondary">
          Choose any start minute. The block goes on air after publishing and
          returns to what was playing before when its events finish.
        </p>
        <Button disabled={busy} onClick={() => void create()}>
          Create timed block
        </Button>
      </Modal>
      <Modal
        isOpen={overrunAsk}
        onClose={() => setOverrunAsk(false)}
        title="This block overruns a fixed start"
      >
        <p className="rundown-inspector-note" role="alert">
          {formatRundownDuration(layout.overrunMs)} of content is cut at the
          next fixed start. Shorten the block or move the pin before air, or
          publish it as it is.
        </p>
        <div className="rundown-actions mt-5">
          <Button
            size="xs"
            variant="secondary"
            onClick={() => setOverrunAsk(false)}
          >
            Keep editing
          </Button>
          <Button
            size="xs"
            variant="destructive"
            disabled={busy}
            onClick={() => {
              setOverrunAsk(false);
              void publish();
            }}
          >
            Publish anyway
          </Button>
        </div>
      </Modal>
      <Modal
        isOpen={recordIndex !== null}
        onClose={() => setRecordIndex(null)}
        title="Record voice track"
      >
        {recordSong && recordIndex !== null ? (
          <VoiceTrackRecorder
            songTitle={recordSong.title}
            songUrl={recordSong.audioUrl}
            onClose={() => setRecordIndex(null)}
            onAttach={async (instantId, mix) => {
              const next = items.map((item, index) =>
                index === recordIndex
                  ? {
                      ...item,
                      voiceTrackInstantId: instantId,
                      voiceDuckGain: mix.duckGain,
                      voiceFadeInSeconds: mix.fadeInSeconds,
                      voiceFadeOutSeconds: mix.fadeOutSeconds,
                    }
                  : item,
              );
              await save(next);
              await load();
            }}
          />
        ) : null}
      </Modal>
    </main>
  );
}

/** A preflight line by the event's name, as the log shows it; the backend's text when it names no event. */
function PreflightLine({
  text,
  event,
}: {
  text: string;
  event?: PreflightEvent | null;
}) {
  if (!event) return <>{text}</>;
  return (
    <span title={text}>
      <strong>{event.name}</strong>: {event.reason}
    </span>
  );
}
