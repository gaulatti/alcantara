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
  Radio,
  Save,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import "../components/BroadcastConsole.css";
import { RundownFillers } from "./RundownFillers";
import { rundownTiming } from "../utils/rundownTiming";
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

function nextLocalHour(): string {
  const date = new Date();
  date.setHours(date.getHours() + 1, 0, 0, 0);
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
}: {
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const [programId] = useGlobalProgramId();
  const [logs, setLogs] = useState<FlightSequence[]>([]);
  const [songs, setSongs] = useState<SongCatalogItem[]>([]);
  const [clips, setClips] = useState<InstantItem[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [items, setItems] = useState<FlightCue[]>([]);
  const [hour, setHour] = useState(nextLocalHour);
  const [busy, setBusy] = useState(false);
  const [preflight, setPreflight] = useState<{
    ready: boolean;
    issues: string[];
  } | null>(null);
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
    const [sequences, songResponse, clipResponse] = await Promise.all([
      fetchFlightSequences(programId),
      fetch(apiUrl("/songs?page=1&limit=200")),
      fetch(apiUrl("/instants")),
    ]);
    if (!songResponse.ok || !clipResponse.ok)
      throw new Error("Radio library is unavailable");
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
  }, [programId]);

  useEffect(() => {
    void load().catch((cause) => setError(message(cause)));
  }, [load]);
  useEffect(() => {
    setItems(selected?.items ?? []);
    setPreflight(null);
  }, [selectedId, selected?.revision]);

  const create = async () => {
    setError(null);
    const scheduledAt = new Date(hour);
    if (
      !Number.isFinite(scheduledAt.getTime()) ||
      scheduledAt.getTime() <= Date.now()
    ) {
      setError("Choose a future hour.");
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
      showAlert("Draft radio log created.", "success");
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
      showAlert("Log published for automatic start.", "success");
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  };

  const updateItem = (index: number, patch: Partial<FlightCue>) =>
    setItems((current) =>
      current.map((item, row) =>
        row === index ? { ...item, ...patch } : item,
      ),
    );
  const add = (kind: "playSong" | "instant" | "stopSong") => {
    const cue: FlightCue = {
      id: crypto.randomUUID(),
      kind,
      ...(items.length === 0 ? { clockOffsetSeconds: 0 } : {}),
    };
    if (kind === "playSong")
      cue.songId = songs.find((song) => song.enabled)?.id;
    if (kind === "instant")
      cue.instantId = clips.find((clip) => clip.enabled)?.id;
    setItems((current) => [...current, cue]);
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
  return (
    <main className="broadcast-console radio-log-planner min-h-full bg-dark-sand px-4 py-5 text-text-primary lg:px-7">
      <AlertContainer />
      <div className="mx-auto max-w-[92rem] space-y-5">
        <header className="flex flex-wrap items-end justify-between gap-4 border-b border-border-subtle pb-5">
          <div>
            <p className="mb-1 flex items-center gap-2 text-xs font-bold uppercase tracking-[0.18em] text-accent-blue">
              <Radio size={15} /> Radio production
            </p>
            <h1 className="text-3xl font-semibold">Rundown</h1>
            <p className="mt-1 text-sm text-text-secondary">
              Library tags → clock blocks → one reviewed log for air.
            </p>
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <label className="text-xs font-semibold text-text-secondary">
              New hour
              <Input
                type="datetime-local"
                step="3600"
                value={hour}
                onChange={(event) => setHour(event.target.value)}
              />
            </label>
            <Button type="button" onClick={() => void create()} disabled={busy}>
              <Plus size={16} /> New rundown
            </Button>
          </div>
        </header>
        {error ? (
          <div
            role="alert"
            className="rounded-xl border border-red-400/40 bg-red-500/10 px-4 py-3 text-sm text-red-300"
          >
            {error}
          </div>
        ) : null}
        <div className="grid gap-5 lg:grid-cols-[13rem_minmax(0,1fr)] 2xl:grid-cols-[13rem_minmax(0,1fr)_20rem]">
          <aside className="rounded-xl border border-border-subtle bg-sand/5 p-3">
            <h2 className="px-2 pb-3 text-xs font-bold uppercase tracking-wider text-text-secondary">
              Scheduled hours
            </h2>
            <div className="space-y-1">
              {scheduledLogs.length ? (
                scheduledLogs.map((log) => (
                  <button
                    key={log.id}
                    type="button"
                    disabled={busy || dirty}
                    title={
                      dirty
                        ? "Save or discard the current draft first"
                        : undefined
                    }
                    onClick={() => setSelectedId(log.id)}
                    className={`w-full rounded-lg border px-3 py-3 text-left ${selectedId === log.id ? "border-accent-blue/60 bg-accent-blue/15" : "border-transparent hover:bg-sand/10"}`}
                  >
                    <span className="block text-sm font-semibold">
                      {new Date(log.scheduledAt!).toLocaleString(undefined, {
                        weekday: "short",
                        month: "short",
                        day: "numeric",
                        hour: "numeric",
                        minute: "2-digit",
                      })}
                    </span>
                    <span className="mt-1 block text-xs text-text-secondary">
                      {log.isRunning
                        ? "ON AIR"
                        : log.publishedAt
                          ? log.lastStartedAt
                            ? "Aired / interrupted"
                            : "Ready for air"
                          : "Draft"}{" "}
                      · {log.items.length} items
                    </span>
                  </button>
                ))
              ) : (
                <p className="px-2 py-8 text-center text-sm text-text-secondary">
                  No scheduled rundowns yet.
                </p>
              )}
            </div>
          </aside>
          <section className="min-w-0 rounded-xl border border-border-subtle bg-sand/5">
            {selected ? (
              <>
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border-subtle p-4">
                  <div>
                    <div className="flex items-center gap-2">
                      <Clock3 size={18} className="text-accent-blue" />
                      <h2 className="text-lg font-semibold">
                        {new Date(selected.scheduledAt!).toLocaleString(
                          undefined,
                          { dateStyle: "full", timeStyle: "short" },
                        )}
                      </h2>
                    </div>
                    <p className="mt-1 text-xs text-text-secondary">
                      Revision {selected.revision} ·{" "}
                      {selected.isRunning
                        ? "On air"
                        : selected.publishedAt
                          ? "Published"
                          : "Draft"}
                      {dirty ? " · Unsaved changes" : ""}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    {dirty && (
                      <Button
                        type="button"
                        variant="ghost"
                        disabled={busy}
                        onClick={() => {
                          setItems(selected.items);
                          setPreflight(null);
                        }}
                      >
                        Discard changes
                      </Button>
                    )}
                    <Button
                      type="button"
                      variant="secondary"
                      onClick={() => void save()}
                      disabled={
                        !dirty ||
                        busy ||
                        (!!selected.lastStartedAt && !selected.isRunning)
                      }
                    >
                      <Save size={15} /> Save
                    </Button>
                    <Button
                      type="button"
                      onClick={() => void publish()}
                      disabled={busy || selected.isRunning}
                    >
                      {selected.publishedAt ? "Recheck and publish" : "Publish"}
                    </Button>
                  </div>
                </div>
                <div className="space-y-2 p-4">
                  {items.map((item, index) => {
                    const locked = index <= activeIndex;
                    const song = item.songId
                      ? songs.find((candidate) => candidate.id === item.songId)
                      : null;
                    return (
                      <div
                        key={item.id}
                        className={`grid gap-3 rounded-xl border p-3 md:grid-cols-[4rem_minmax(0,1fr)_8rem_auto] ${locked ? "border-green-500/40 bg-green-500/5" : "border-border-subtle bg-dark-sand/40"}`}
                      >
                        <span className="self-center font-mono text-sm font-bold text-text-secondary">
                          {String(index + 1).padStart(2, "0")}
                        </span>
                        <div className="min-w-0">
                          <span className="text-[10px] font-bold uppercase tracking-widest text-accent-blue">
                            {item.kind === "playSong"
                              ? item.isFiller
                                ? "Filler"
                                : "Song"
                              : item.kind === "instant"
                                ? "Audio clip"
                                : "Stop"}
                          </span>
                          {item.kind === "playSong" ? (
                            <Select
                              value={item.songId ? String(item.songId) : ""}
                              onChange={(value) =>
                                updateItem(index, { songId: Number(value) })
                              }
                              disabled={locked}
                              options={[
                                { value: "", label: "Choose song" },
                                ...songs.map((candidate) => ({
                                  value: String(candidate.id),
                                  label: `${candidate.artist} — ${candidate.title}${candidate.enabled ? "" : " (disabled)"}`,
                                })),
                              ]}
                            />
                          ) : item.kind === "instant" ? (
                            <Select
                              value={
                                item.instantId ? String(item.instantId) : ""
                              }
                              onChange={(value) =>
                                updateItem(index, { instantId: Number(value) })
                              }
                              disabled={locked}
                              options={[
                                { value: "", label: "Choose clip" },
                                ...clips.map((candidate) => ({
                                  value: String(candidate.id),
                                  label: `${candidate.name}${candidate.enabled ? "" : " (disabled)"}`,
                                })),
                              ]}
                            />
                          ) : (
                            <p className="text-sm">End program audio</p>
                          )}
                          <p className="mt-1 text-xs text-text-secondary">
                            {timing[index].durationMs
                              ? `${Math.round(timing[index].durationMs! / 1000)}s`
                              : item.kind === "stopSong"
                                ? "Stops audio"
                                : "Duration required for fillers"}
                            {timing[index].gapMs
                              ? ` · ${Math.ceil(timing[index].gapMs! / 1000)}s ${item.kind === "stopSong" ? "intentional silence" : "to fill"}`
                              : ""}
                            {timing[index].cutMs
                              ? ` · ${Math.ceil(timing[index].cutMs! / 1000)}s ${item.isFiller ? "cut at next boundary" : "content overrun"}`
                              : ""}
                          </p>
                          {item.kind === "instant" && (
                            <label className="mt-2 block text-xs text-text-secondary">
                              Clip duration (seconds)
                              <Input
                                aria-label={`Clip duration for event ${index + 1}`}
                                type="number"
                                min="1"
                                value={
                                  item.durationMs ? item.durationMs / 1000 : ""
                                }
                                disabled={locked}
                                onChange={(event) =>
                                  updateItem(index, {
                                    durationMs: event.target.value
                                      ? Number(event.target.value) * 1000
                                      : undefined,
                                  })
                                }
                              />
                            </label>
                          )}
                          {item.voiceTrackInstantId ? (
                            <p className="mt-1 text-xs text-violet-300">
                              Voice track #{item.voiceTrackInstantId} · song at{" "}
                              {Math.round((item.voiceDuckGain ?? 0.35) * 100)}%
                            </p>
                          ) : null}
                        </div>
                        <label className="text-[10px] font-bold uppercase tracking-wide text-text-secondary">
                          Fixed start (+sec)
                          <Input
                            type="number"
                            min="0"
                            max={
                              item.kind === "stopSong" &&
                              index === items.length - 1
                                ? "3600"
                                : "3599"
                            }
                            value={item.clockOffsetSeconds ?? ""}
                            onChange={(event) =>
                              updateItem(index, {
                                clockOffsetSeconds:
                                  event.target.value === ""
                                    ? undefined
                                    : Number(event.target.value),
                              })
                            }
                            disabled={locked || index === 0}
                            placeholder="After previous"
                          />
                          <span className="font-normal normal-case">
                            {formatClock(item.clockOffsetSeconds)}
                          </span>
                        </label>
                        <div className="flex items-center gap-1">
                          {item.kind === "playSong" && song ? (
                            <Button
                              type="button"
                              size="xs"
                              variant="secondary"
                              onClick={() => setRecordIndex(index)}
                              disabled={locked}
                            >
                              <Mic2 size={14} /> Voice
                            </Button>
                          ) : null}
                          <Button
                            type="button"
                            size="xs"
                            variant="destructive"
                            onClick={() =>
                              setItems((current) => {
                                const next = current.filter(
                                  (_, row) => row !== index,
                                );
                                if (next[0])
                                  next[0] = {
                                    ...next[0],
                                    clockOffsetSeconds: 0,
                                  };
                                return next;
                              })
                            }
                            disabled={locked}
                          >
                            <Trash2 size={14} />
                          </Button>
                        </div>
                      </div>
                    );
                  })}
                  <div className="flex flex-wrap gap-2 pt-2">
                    <Button
                      type="button"
                      variant="secondary"
                      onClick={() => add("playSong")}
                      disabled={
                        busy ||
                        (!!selected.lastStartedAt && !selected.isRunning)
                      }
                    >
                      <Plus size={14} /> Song
                    </Button>
                    <Button
                      type="button"
                      variant="secondary"
                      onClick={() => add("instant")}
                      disabled={
                        busy ||
                        (!!selected.lastStartedAt && !selected.isRunning)
                      }
                    >
                      <Plus size={14} /> Clip
                    </Button>
                    <Button
                      type="button"
                      variant="secondary"
                      onClick={() => add("stopSong")}
                      disabled={
                        busy ||
                        (!!selected.lastStartedAt && !selected.isRunning)
                      }
                    >
                      <Plus size={14} /> Stop
                    </Button>
                  </div>
                </div>
              </>
            ) : (
              <div className="p-12 text-center text-sm text-text-secondary">
                Create or choose an hour to start building its rundown.
              </div>
            )}
          </section>
          <aside className="space-y-4 lg:col-span-2 lg:grid lg:grid-cols-2 lg:gap-4 lg:space-y-0 2xl:col-span-1 2xl:block 2xl:space-y-4">
            <RadioLogGenerator
              programId={programId}
              log={selected}
              onGenerated={(generated) => {
                setItems(generated);
                setPreflight(null);
              }}
            />
            <RundownFillers
              programId={programId}
              rundown={selected}
              items={items}
              onFilled={(filled) => {
                setItems(filled);
                setPreflight(null);
              }}
            />
            <div className="rounded-xl border border-border-subtle bg-sand/5 p-4">
              <h2 className="text-sm font-bold">Air readiness</h2>
              <p className="mt-1 text-xs text-text-secondary">
                Checks catalog availability before the hour is published.
              </p>
              <Button
                type="button"
                variant="secondary"
                className="mt-4 w-full"
                onClick={() => void check()}
                disabled={!selected || busy}
              >
                Check rundown
              </Button>
              {preflight ? (
                <div
                  className={`mt-3 rounded-lg p-3 text-sm ${preflight.ready ? "bg-green-500/10 text-green-300" : "bg-amber-500/10 text-amber-300"}`}
                >
                  {preflight.ready ? (
                    <span className="flex items-center gap-2">
                      <CheckCircle2 size={16} /> Ready to publish
                    </span>
                  ) : (
                    <>
                      <span className="flex items-center gap-2 font-bold">
                        <AlertTriangle size={16} /> Needs attention
                      </span>
                      <ul className="mt-2 list-disc pl-5">
                        {preflight.issues.map((issue) => (
                          <li key={issue}>{issue}</li>
                        ))}
                      </ul>
                    </>
                  )}
                </div>
              ) : null}
            </div>
            <div className="rounded-xl border border-border-subtle bg-sand/5 p-4">
              <h2 className="text-sm font-bold">Timing guide</h2>
              <p className="mt-1 text-xs text-text-secondary">
                A fixed start cuts to that item at its clock position. Items
                without one follow the previous song’s confirmed end.
              </p>
              <div className="mt-3 space-y-2">
                {items.map((item, index) => (
                  <div
                    key={item.id}
                    className="flex justify-between gap-2 border-b border-border-subtle pb-2 text-xs"
                  >
                    <span className="truncate">
                      {index + 1}.{" "}
                      {item.kind === "playSong"
                        ? (songs.find((song) => song.id === item.songId)
                            ?.title ?? "Missing song")
                        : item.kind === "instant"
                          ? (clips.find((clip) => clip.id === item.instantId)
                              ?.name ?? "Missing clip")
                          : "Stop"}
                    </span>
                    <span className="shrink-0 font-mono text-text-secondary">
                      {formatClock(item.clockOffsetSeconds)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </aside>
        </div>
      </div>
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
