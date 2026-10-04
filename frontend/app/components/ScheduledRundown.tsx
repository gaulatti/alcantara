import {
  AlertContainer,
  Button,
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
import { rundownTiming } from "../utils/rundownTiming";
import "./Rundown.css";
import { RadioLogGenerator } from "../components/RadioLogGenerator";
import { VoiceTrackRecorder } from "../components/VoiceTrackRecorder";
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
} from "../services/flight";
import { apiUrl } from "../utils/apiBaseUrl";
import { useGlobalProgramId } from "../utils/globalProgram";

function nextLocalStart(): string {
  const date = new Date();
  date.setMinutes(date.getMinutes() + 5, 0, 0);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function formatClock(seconds: number | undefined): string {
  if (seconds === undefined) return "After previous";
  return `+${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : "Request failed";
}

export default function ScheduledRundown({
  onDirtyChange,
  fixtureData,
}: {
  onDirtyChange?: (dirty: boolean) => void;
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
  const [preflight, setPreflight] = useState<{
    ready: boolean;
    issues: string[];
  } | null>(null);
  const [inspector, setInspector] = useState<"event" | "fillers" | "build">(
    "event",
  );
  const [selectedCueId, setSelectedCueId] = useState<string | null>(null);
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
        fetch(apiUrl(`/program/${encodeURIComponent(programId)}/audio-bus`)),
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
    setPreflight(null);
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
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      const updated = dirty ? await save() : selected;
      const result = await preflightFlightSequence(programId, updated.id);
      setPreflight(result);
      if (result.ready)
        showAlert("All scheduled audio is available.", "success");
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  };

  const publish = async () => {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      const updated = dirty ? await save() : selected;
      const published = await publishFlightSequence(
        programId,
        updated.id,
        updated.revision,
      );
      setLogs((current) =>
        current.map((log) => (log.id === published.id ? published : log)),
      );
      setPreflight({ ready: true, issues: [] });
      showAlert("Rundown published for automatic start.", "success");
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  };

  const updateItem = (index: number, patch: Partial<FlightCue>) => {
    setPreflight(null);
    setItems((current) =>
      current.map((item, row) =>
        row === index ? { ...item, ...patch } : item,
      ),
    );
  };
  const add = (kind: "playSong" | "instant" | "stopSong") => {
    setPreflight(null);
    const cue: FlightCue = {
      id: crypto.randomUUID(),
      kind,
      ...(items.length === 0 ? { clockOffsetSeconds: 0 } : {}),
    };
    if (kind === "playSong")
      cue.songId = songs.find((song) => song.enabled)?.id;
    if (kind === "instant")
      cue.instantId = clips.find((clip) => clip.enabled)?.id;
    setItems((current) => {
      const end = current.at(-1);
      return end?.kind === "stopSong" && end.clockOffsetSeconds !== undefined
        ? [...current.slice(0, -1), cue, end]
        : [...current, cue];
    });
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
  const revealInspector = () => {
    if (window.matchMedia("(max-width: 760px)").matches) {
      requestAnimationFrame(() =>
        inspectorRef.current?.scrollIntoView({ block: "start" }),
      );
    }
  };
  const editIndex = items.findIndex((cue) => cue.id === selectedCueId);
  const editCue = items[editIndex];
  const editLocked = editIndex <= activeIndex;
  const editable =
    !!selected && (!selected.lastStartedAt || selected.isRunning);
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
        <div>
          <span className="console-eyebrow">Radio production</span>
          <h1>Rundown</h1>
          <p>{programId} · Scheduled content and fillers</p>
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
                  label: `${new Date(log.scheduledAt!).toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })} · ${log.isRunning ? "On air" : log.lastStartedAt ? "Aired" : log.publishedAt ? "Published" : "Draft"}`,
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
        <div>
          <span className="console-eyebrow">Base playout · 24/7</span>
          <strong>Continuous fillers</strong>
          <p>
            {rotationCount === null
              ? "Your saved rotation runs independently of timed blocks."
              : `${rotationCount} saved songs · runs independently of timed blocks.`}{" "}
            No hourly schedules required.
          </p>
        </div>
        <Link to="/control">Manage rotation & live controls</Link>
      </section>
      <div className="rundown-desk">
        <section className="rundown-sequence" aria-label="Timed block rundown">
          <div className="rundown-sequence-heading">
            <div>
              <h2>Block events</h2>
              <p>
                {selected
                  ? `${selected.isRunning ? "ON AIR" : selected.lastStartedAt ? "AIRED / INTERRUPTED" : selected.publishedAt ? "PUBLISHED" : "DRAFT"} · Revision ${selected.revision} · ${items.length} events${dirty ? " · Unsaved changes" : ""}`
                  : "Continuous fillers run independently. Create a block only for timed content."}
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
                disabled={
                  !selected ||
                  busy ||
                  !!fixtureData ||
                  !!selected.lastStartedAt ||
                  !!selected.isRunning
                }
                onClick={() => void publish()}
              >
                Publish
              </Button>
            </div>
          </div>
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
              <strong>Timed content interrupts continuous fillers</strong>
              <p>
                Your filler rotation needs no scheduled blocks. Add a block for
                news, a show, or other timed content.
              </p>
            </div>
          )}
          <div className="rundown-insert">
            <Button
              size="xs"
              variant="secondary"
              disabled={busy || !editable}
              onClick={() => add("playSong")}
            >
              <Plus size={13} /> Song
            </Button>
            <Button
              size="xs"
              variant="secondary"
              disabled={busy || !editable}
              onClick={() => add("instant")}
            >
              <Plus size={13} /> Clip
            </Button>
            <Button
              size="xs"
              variant="secondary"
              disabled={busy || !editable}
              onClick={() => add("stopSong")}
            >
              <Plus size={13} /> Stop
            </Button>
            <Button
              size="xs"
              variant="ghost"
              disabled={!selected}
              onClick={() => setInspector("fillers")}
            >
              Fill gaps
            </Button>
          </div>
          {preflight && (
            <div className="rundown-sequence-heading" role="status">
              {preflight.ready ? (
                <span className="console-status" data-tone="ready">
                  <CheckCircle2 size={13} /> Audio checked · ready for air
                </span>
              ) : (
                <div>
                  <span className="console-status" data-tone="warning">
                    <AlertTriangle size={13} /> Needs attention
                  </span>
                  <ul>
                    {preflight.issues.map((issue) => (
                      <li key={issue}>{issue}</li>
                    ))}
                  </ul>
                </div>
              )}
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
                ["build", "Build block"],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                aria-pressed={inspector === id}
                onClick={() => setInspector(id)}
              >
                {label}
              </button>
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
                    Fixed start (seconds into block)
                    <Input
                      aria-label="Fixed start"
                      type="number"
                      min="0"
                      value={editCue.clockOffsetSeconds ?? ""}
                      disabled={editLocked || editIndex === 0 || busy}
                      placeholder="Follow previous event"
                      onChange={(event) =>
                        updateItem(editIndex, {
                          clockOffsetSeconds:
                            event.target.value === ""
                              ? undefined
                              : Number(event.target.value),
                        })
                      }
                    />
                  </label>
                  <p className="rundown-inspector-note">
                    {editCue.clockOffsetSeconds === undefined
                      ? "Follows the previous event. The start in the log is estimated from catalog duration."
                      : `${formatClock(editCue.clockOffsetSeconds)} · Starts on time and cuts the preceding filler.`}
                  </p>
                  {editCue.voiceTrackInstantId && (
                    <p className="rundown-inspector-note">
                      Voice track #{editCue.voiceTrackInstantId} · music at{" "}
                      {Math.round((editCue.voiceDuckGain ?? 0.35) * 100)}%
                    </p>
                  )}
                  <div className="rundown-actions mt-5">
                    {editCue.kind === "playSong" &&
                      songs.some((song) => song.id === editCue.songId) && (
                        <Button
                          size="xs"
                          variant="secondary"
                          disabled={editLocked || busy || !!fixtureData}
                          onClick={() => setRecordIndex(editIndex)}
                        >
                          <Mic2 size={13} /> Record voice
                        </Button>
                      )}
                    <Button
                      size="xs"
                      variant="destructive"
                      disabled={editLocked || busy}
                      onClick={remove}
                    >
                      <Trash2 size={13} /> Remove
                    </Button>
                  </div>
                </>
              ) : (
                <>
                  <span className="console-eyebrow">Event inspector</span>
                  <h2 className="mt-2">Select an event</h2>
                  <p className="rundown-inspector-note">
                    Read the block in the log. Select a row to change its
                    source, fixed start, clip duration, or voice track.
                  </p>
                  <p className="rundown-inspector-note">
                    Fixed starts are marked with a clock. Estimated starts
                    follow the previous event’s actual end.
                  </p>
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
            aria-label="New block"
            type="datetime-local"
            step="60"
            value={startTime}
            onChange={(event) => setStartTime(event.target.value)}
          />
        </label>
        <p className="my-3 text-xs text-text-secondary">
          Choose any start minute. The block goes on air after publishing and
          returns to continuous fillers when its events finish.
        </p>
        <Button disabled={busy} onClick={() => void create()}>
          Create rundown
        </Button>
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
