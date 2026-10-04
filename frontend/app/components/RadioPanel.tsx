import { useCallback, useEffect, useState } from "react";
import { Button, Select } from "@gaulatti/bleecker";
import { apiUrl } from "../utils/apiBaseUrl";
import {
  AlertTriangle,
  List,
  Plus,
  Radio,
  ArrowUp,
  ArrowDown,
  Trash2,
  ListPlus,
} from "lucide-react";
import { ConsoleClock, ConsolePanel } from "./ConsoleSurface";
import { Link } from "react-router";
import type {
  ProgramSongPlaybackState,
  ProgramSongQueueEntry,
  SongCatalogItem,
  InstantItem,
} from "../models/broadcast";
import { PlaybackBar } from "./PlaybackBar";
import { InstantsPanel } from "./panels";
import { faderToDb } from "../utils/audioTaper";
import {
  fetchFlightSequences,
  updateFlightSequence,
  activateFlightSequence,
  startFlight,
  stopFlight,
  goFlight,
} from "../services/flight";
import type { FlightSequence } from "../models/broadcast";

interface RadioMixerChannelState {
  volume: number;
  muted?: boolean;
  peak: number;
}

export interface RadioMixerState {
  song: RadioMixerChannelState;
  instants: RadioMixerChannelState;
  main: RadioMixerChannelState;
  saving: boolean;
  error: string | null;
}

interface RadioPanelProps {
  fixtureData?: {
    stream: StreamStatus;
    palazzo: PalazzoStatus;
    output: OutputConfidence;
    logs: FlightSequence[];
    recovery: RecoveryStatus;
  };
  programId: string;
  songSequence: any;
  songQueue: ProgramSongQueueEntry[];
  songCatalog: SongCatalogItem[];
  programSongPlayback: ProgramSongPlaybackState | null;
  onSaveSongSequence: (seq: any) => Promise<void> | void;
  onQueueSong: (itemId: string) => Promise<void> | void;
  onRemoveQueuedSong: (entryId: string) => Promise<void> | void;
  onReorderSongQueue: (entryIds: string[]) => Promise<void> | void;
  onTakeOffAir: () => Promise<void>;
  instants: InstantItem[];
  instantSearch: string;
  onInstantSearchChange: (v: string) => void;
  onTriggerInstant: (id: number) => void;
  onStopAllInstants: () => void;
  instantPlayback: Record<
    number,
    { startedAtMs: number; endsAtMs: number | null }
  >;
  mixer: RadioMixerState;
  onSongVolumeChange: (value: number) => void;
  onInstantVolumeChange: (value: number) => void;
  onMainVolumeChange: (value: number) => void;
  onToggleSongMuted: () => void;
  onToggleInstantMuted: () => void;
}

interface StreamStatus {
  running: boolean;
  uptime: number | null;
}

interface PalazzoStatus {
  programId: string;
  programType: string;
  palazzoUrl: string;
  instanceId: string | null;
  connection:
    | "connecting"
    | "connected"
    | "polling"
    | "unavailable"
    | "instance-mismatch"
    | "instance-conflict";
  lastEventAt: string | null;
  lastSnapshotAt: string | null;
  degraded: boolean;
  detail: string | null;
}

interface OutputConfidence {
  state: "unknown" | "unavailable" | "idle" | "checking" | "audible" | "silent";
  expectedAudio: boolean;
  outputRms: number | null;
  lastSampleAt: string | null;
  quietForMs: number | null;
}
interface RecoveryStatus {
  preparedVersion: string | null;
  automation: {
    actualState: string;
    filler: { activeVersion: string | null; ready: boolean };
  } | null;
  connection: "connected" | "unavailable";
}

export const RadioPanel: React.FC<RadioPanelProps> = ({
  fixtureData,
  programId,
  songCatalog,
  programSongPlayback,
  instants,
  instantSearch,
  onInstantSearchChange,
  onTriggerInstant,
  onStopAllInstants,
  instantPlayback,
  mixer,
  onSongVolumeChange,
  onInstantVolumeChange,
  onMainVolumeChange,
  onToggleSongMuted,
  onToggleInstantMuted,
}) => {
  const [stream, setStream] = useState<StreamStatus | null>(
    fixtureData?.stream ?? null,
  );
  const [palazzo, setPalazzo] = useState<PalazzoStatus | null>(
    fixtureData?.palazzo ?? null,
  );
  const [selectedLogId, setSelectedLogId] = useState<number | null>(null);
  const [addSongId, setAddSongId] = useState("");
  const [logBusy, setLogBusy] = useState(false);
  const [logLoadError, setLogLoadError] = useState<string | null>(null);
  const [queueError, setQueueError] = useState<string | null>(null);
  const [output, setOutput] = useState<OutputConfidence | null>(
    fixtureData?.output ?? null,
  );
  const [logs, setLogs] = useState<FlightSequence[]>(fixtureData?.logs ?? []);
  const [recovery, setRecovery] = useState<RecoveryStatus | null>(
    fixtureData?.recovery ?? null,
  );
  const [recoveryBusy, setRecoveryBusy] = useState(false);
  const [recoveryError, setRecoveryError] = useState<string | null>(null);

  const fetchStreamStatus = useCallback(async () => {
    try {
      const res = await fetch(
        apiUrl(`/radio/${encodeURIComponent(programId)}/status`),
      );
      setStream(res.ok ? await res.json() : null);
    } catch {
      setStream(null);
    }
  }, [programId]);

  const fetchPalazzoStatus = useCallback(async () => {
    try {
      const res = await fetch(
        apiUrl(`/radio/${encodeURIComponent(programId)}/palazzo-status`),
      );
      if (res.ok) {
        const data = await res.json();
        setPalazzo(data || null);
      } else {
        setPalazzo(null);
      }
    } catch {
      setPalazzo(null);
    }
  }, [programId]);

  const fetchAirPlan = useCallback(async () => {
    try {
      const [confidenceResponse, sequences] = await Promise.all([
        fetch(
          apiUrl(`/radio/${encodeURIComponent(programId)}/output-confidence`),
        ).catch(() => null),
        fetchFlightSequences(programId),
      ]);
      setOutput(
        confidenceResponse?.ok ? await confidenceResponse.json() : null,
      );
      setLogLoadError(null);
      setLogs(sequences.filter((sequence) => sequence.scheduledAt !== null));
    } catch (cause) {
      setLogLoadError(
        cause instanceof Error ? cause.message : "Radio logs unavailable",
      );
      setOutput(null);
      setLogs([]);
    }
  }, [programId]);

  const fetchRecovery = useCallback(async () => {
    try {
      const response = await fetch(
        apiUrl(`/radio/${encodeURIComponent(programId)}/recovery`),
      );
      setRecovery(response.ok ? await response.json() : null);
    } catch {
      setRecovery(null);
    }
  }, [programId]);

  const commandRecovery = async (action: "start" | "stop") => {
    setRecoveryBusy(true);
    setRecoveryError(null);
    try {
      const response = await fetch(
        apiUrl(`/radio/${encodeURIComponent(programId)}/recovery/${action}`),
        { method: "POST" },
      );
      if (!response.ok)
        throw new Error(
          `Palazzo could not ${action} recovery (${response.status}).`,
        );
      setRecovery(await response.json());
    } catch (cause) {
      setRecoveryError(
        cause instanceof Error ? cause.message : "Recovery command failed.",
      );
    } finally {
      setRecoveryBusy(false);
    }
  };

  useEffect(() => {
    if (fixtureData) return;
    setStream(null);
    setPalazzo(null);
    setOutput(null);
    setLogs([]);
    setRecovery(null);
    fetchStreamStatus();
    fetchPalazzoStatus();
    fetchAirPlan();
    fetchRecovery();
    const interval = setInterval(fetchStreamStatus, 8000);
    const palazzoInterval = setInterval(fetchPalazzoStatus, 8000);
    const airPlanInterval = setInterval(fetchAirPlan, 2000);
    const recoveryInterval = setInterval(fetchRecovery, 8000);
    return () => {
      clearInterval(interval);
      clearInterval(palazzoInterval);
      clearInterval(airPlanInterval);
      clearInterval(recoveryInterval);
    };
  }, [
    fetchStreamStatus,
    fetchPalazzoStatus,
    fetchAirPlan,
    fetchRecovery,
    fixtureData,
  ]);

  const isLive = stream?.running === true;
  const runningLog = logs.find((sequence) => sequence.isRunning) ?? null;
  const nextLog =
    logs
      .filter(
        (sequence) =>
          sequence.publishedAt &&
          !sequence.lastStartedAt &&
          sequence.scheduledAt &&
          Date.parse(sequence.scheduledAt) > Date.now(),
      )
      .sort(
        (a, b) => Date.parse(a.scheduledAt!) - Date.parse(b.scheduledAt!),
      )[0] ?? null;
  const activeLog =
    runningLog ??
    logs.find((log) => log.id === selectedLogId) ??
    nextLog ??
    [...logs]
      .filter((log) => log.lastStartedAt)
      .sort(
        (a, b) => Date.parse(b.scheduledAt!) - Date.parse(a.scheduledAt!),
      )[0] ??
    null;
  const refreshLogs = async () => {
    if (!fixtureData)
      setLogs(
        (await fetchFlightSequences(programId)).filter(
          (log) => log.scheduledAt,
        ),
      );
  };
  const commandLog = async (action: "start" | "stop" | "advance") => {
    setLogBusy(true);
    setQueueError(null);
    try {
      if (action === "stop") await stopFlight(programId);
      else if (action === "advance") await goFlight(programId);
      else if (activeLog) {
        await activateFlightSequence(programId, activeLog.id);
        await startFlight(programId);
      }
      await refreshLogs();
    } catch (cause) {
      setQueueError(
        cause instanceof Error ? cause.message : "Log command failed",
      );
    } finally {
      setLogBusy(false);
    }
  };
  const editLog = async (items: FlightSequence["items"]) => {
    if (!activeLog) return;
    setLogBusy(true);
    setQueueError(null);
    try {
      const updated = await updateFlightSequence(programId, activeLog.id, {
        items,
        revision: activeLog.revision,
      });
      setLogs((current) =>
        current.map((log) => (log.id === updated.id ? updated : log)),
      );
    } catch (cause) {
      setQueueError(
        cause instanceof Error ? cause.message : "The log was not changed",
      );
      await refreshLogs();
    } finally {
      setLogBusy(false);
    }
  };
  const moveCue = (index: number, target: number) => {
    if (!activeLog) return;
    const items = [...activeLog.items];
    const [cue] = items.splice(index, 1);
    items.splice(target, 0, cue);
    void editLog(items);
  };
  const currentLogIndex = activeLog?.isRunning
    ? activeLog.items.findIndex((item) => item.id === activeLog.activeItemId)
    : -1;
  const outputTone =
    output?.state === "silent" || output?.state === "unavailable"
      ? "live"
      : output?.state === "audible"
        ? "ready"
        : "warning";
  const outputLabel =
    output?.state === "audible"
      ? "Audio detected"
      : output?.state === "silent"
        ? "Expected audio is silent"
        : output?.state === "unavailable"
          ? "Output unavailable"
          : output?.state === "idle"
            ? "Output idle"
            : output?.state === "checking"
              ? "Checking output"
              : "Output unverified";
  const engineReady =
    palazzo?.connection === "connected" || palazzo?.connection === "polling";

  return (
    <div className="broadcast-console radio-console" data-console="radio">
      <header className="console-toolbar">
        <div className="console-toolbar-title">
          <span className="console-eyebrow">Radio / Live control</span>
          {programId}
        </div>
        <span
          className="console-status"
          data-tone={stream === null ? "warning" : isLive ? "ready" : "live"}
        >
          {stream === null
            ? "Stream unverified"
            : isLive
              ? "Stream connected"
              : "Stream offline"}
        </span>
        <span
          className="console-status"
          data-tone={engineReady && !palazzo?.degraded ? "ready" : "warning"}
          title={palazzo?.detail ?? undefined}
        >
          {engineReady
            ? palazzo?.degraded
              ? "Engine degraded"
              : "Engine connected"
            : "Engine unavailable"}
        </span>
        <ConsoleClock />
      </header>
      <div className="radio-console-scroll">
        <div className="radio-workspace">
          <ConsolePanel
            title="On-air log"
            eyebrow="Playout"
            className="radio-rundown"
            actions={
              <Link
                to="/radio-log"
                className="inline-flex items-center gap-1 text-sm"
              >
                <List size={14} /> Prepare hours
              </Link>
            }
          >
            <div className="console-log-summary flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0 flex-1">
                {activeLog ? (
                  <>
                    <strong>{activeLog.name}</strong>
                    <small className="block">
                      {new Date(activeLog.scheduledAt!).toLocaleString()} ·{" "}
                      {activeLog.isRunning
                        ? Date.parse(activeLog.scheduledAt!) > Date.now()
                          ? "ARMED"
                          : "ON AIR"
                        : activeLog.publishedAt
                          ? activeLog.lastStartedAt
                            ? "Aired / stopped"
                            : "Published"
                          : "Draft"}{" "}
                      · Revision {activeLog.revision}
                    </small>
                  </>
                ) : (
                  "No radio log selected"
                )}
              </div>
              {!runningLog && (
                <Select
                  aria-label="Select radio log"
                  value={activeLog ? String(activeLog.id) : ""}
                  onChange={(value) => setSelectedLogId(Number(value))}
                  options={[
                    { value: "", label: "Choose an hour" },
                    ...logs.map((log) => ({
                      value: String(log.id),
                      label: `${new Date(log.scheduledAt!).toLocaleString()} · ${log.publishedAt ? "Published" : "Draft"}`,
                    })),
                  ]}
                />
              )}
              <span className="console-count">
                {activeLog?.items.length ?? 0} events
              </span>
            </div>
            {(queueError || logLoadError) && (
              <p role="alert" className="px-4 py-3 text-sm text-terracotta">
                {queueError || logLoadError}
              </p>
            )}
            <div className="radio-rundown-body">
              {activeLog ? (
                <ol className="console-log" aria-label="On-air log">
                  {activeLog.items.map((cue, index) => {
                    const song =
                      cue.kind === "playSong"
                        ? songCatalog.find((item) => item.id === cue.songId)
                        : null;
                    const clip =
                      cue.kind === "instant"
                        ? instants.find((item) => item.id === cue.instantId)
                        : null;
                    const active =
                      activeLog.isRunning &&
                      Date.parse(activeLog.scheduledAt!) <= Date.now() &&
                      cue.id === activeLog.activeItemId;
                    const next = index === currentLogIndex + 1;
                    const locked =
                      index <= currentLogIndex ||
                      (!!activeLog.lastStartedAt && !activeLog.isRunning);
                    const previous = activeLog.items[index - 1];
                    const successor = activeLog.items[index + 1];
                    const movable =
                      !locked && cue.clockOffsetSeconds === undefined;
                    return (
                      <li
                        key={cue.id}
                        className="console-log-row"
                        data-active={active}
                        data-played={index < currentLogIndex}
                      >
                        <time>
                          {cue.clockOffsetSeconds === undefined
                            ? "Follows"
                            : new Date(
                                Date.parse(activeLog.scheduledAt!) +
                                  cue.clockOffsetSeconds * 1000,
                              ).toLocaleTimeString(undefined, {
                                hour12: false,
                              })}
                        </time>
                        <div className="min-w-0">
                          <span className="block truncate font-semibold">
                            {song?.title ??
                              clip?.name ??
                              (cue.kind === "stopSong"
                                ? "Stop audio"
                                : "Unavailable audio")}
                          </span>
                          <small>
                            {song?.artist ??
                              (clip ? "Audio clip" : "Transport command")}
                            {cue.voiceTrackInstantId ? " · Voice track" : ""}
                          </small>
                        </div>
                        <span className="tabular-nums text-xs text-text-secondary">
                          {song?.durationMs ? formatTime(song.durationMs) : "—"}
                        </span>
                        <span className="console-eyebrow">
                          {active
                            ? "NOW"
                            : next
                              ? "NEXT"
                              : index < currentLogIndex
                                ? "PLAYED"
                                : String(index + 1).padStart(2, "0")}
                        </span>
                        <div className="console-log-actions">
                          <Button
                            type="button"
                            size="xs"
                            variant="ghost"
                            title="Play next"
                            aria-label={`Play event ${index + 1} next`}
                            disabled={
                              logBusy ||
                              !movable ||
                              index <= currentLogIndex + 1 ||
                              activeLog.items
                                .slice(currentLogIndex + 1, index)
                                .some(
                                  (item) =>
                                    item.clockOffsetSeconds !== undefined,
                                )
                            }
                            onClick={() => moveCue(index, currentLogIndex + 1)}
                          >
                            <ListPlus size={14} />
                          </Button>
                          <Button
                            type="button"
                            size="xs"
                            variant="ghost"
                            aria-label={`Move event ${index + 1} up`}
                            disabled={
                              logBusy ||
                              !movable ||
                              index <= currentLogIndex + 1 ||
                              previous?.clockOffsetSeconds !== undefined
                            }
                            onClick={() => moveCue(index, index - 1)}
                          >
                            <ArrowUp size={14} />
                          </Button>
                          <Button
                            type="button"
                            size="xs"
                            variant="ghost"
                            aria-label={`Move event ${index + 1} down`}
                            disabled={
                              logBusy ||
                              !movable ||
                              !successor ||
                              successor.clockOffsetSeconds !== undefined
                            }
                            onClick={() => moveCue(index, index + 1)}
                          >
                            <ArrowDown size={14} />
                          </Button>
                          <Button
                            type="button"
                            size="xs"
                            variant="ghost"
                            aria-label={`Remove event ${index + 1}`}
                            disabled={
                              logBusy ||
                              locked ||
                              cue.clockOffsetSeconds !== undefined
                            }
                            onClick={() =>
                              void editLog(
                                activeLog.items.filter(
                                  (item) => item.id !== cue.id,
                                ),
                              )
                            }
                          >
                            <Trash2 size={14} />
                          </Button>
                        </div>
                      </li>
                    );
                  })}
                </ol>
              ) : (
                <div className="console-empty">
                  <strong>No published hour is queued.</strong>
                  <p>
                    Prepare an hour from Library tags, review its events, then
                    publish.
                  </p>
                  <Link to="/radio-log">Prepare a radio log</Link>
                </div>
              )}
            </div>
            {activeLog && (
              <div className="console-log-summary flex flex-wrap items-center gap-2">
                <Select
                  aria-label="Song to add to log"
                  value={addSongId}
                  onChange={(value) => setAddSongId(value)}
                  options={[
                    { value: "", label: "Choose a Library song" },
                    ...songCatalog
                      .filter((song) => song.enabled)
                      .map((song) => ({
                        value: String(song.id),
                        label: `${song.artist} — ${song.title}`,
                      })),
                  ]}
                />
                <Button
                  type="button"
                  size="xs"
                  variant="secondary"
                  disabled={
                    !addSongId ||
                    logBusy ||
                    (!!activeLog.lastStartedAt && !activeLog.isRunning)
                  }
                  onClick={() => {
                    const items = [...activeLog.items];
                    const insert = activeLog.isRunning
                      ? currentLogIndex + 1
                      : items.length;
                    items.splice(insert, 0, {
                      id: crypto.randomUUID(),
                      kind: "playSong",
                      songId: Number(addSongId),
                      ...(items.length === 0 ? { clockOffsetSeconds: 0 } : {}),
                    });
                    void editLog(items);
                  }}
                >
                  <Plus size={13} />{" "}
                  {activeLog.isRunning ? "Add next" : "Add event"}
                </Button>
                <Link to="/media" className="ml-auto">
                  Library & tags
                </Link>
              </div>
            )}
          </ConsolePanel>
          <aside className="radio-tools" aria-label="Live audio tools">
            <section
              className="console-panel radio-next"
              aria-label="Output confidence"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="console-eyebrow">Output confidence</span>
                {outputTone === "live" ? (
                  <AlertTriangle size={14} />
                ) : (
                  <Radio size={14} />
                )}
              </div>
              <span
                role="status"
                className="console-status mt-2"
                data-tone={outputTone}
              >
                {outputLabel}
              </span>
              <div className="console-next-foot">
                <span>
                  {output?.lastSampleAt
                    ? `Sample ${new Date(output.lastSampleAt).toLocaleTimeString()}`
                    : "No level sample"}
                </span>
                <span>
                  {isLive && stream?.uptime != null
                    ? `Up ${formatUptime(stream.uptime)}`
                    : ""}
                </span>
              </div>
            </section>
            <ConsolePanel
              title="Cartwall"
              eyebrow="Instant audio"
              className="radio-cartwall"
              actions={
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  onClick={onStopAllInstants}
                >
                  Stop all
                </Button>
              }
            >
              <div className="radio-cartwall-body">
                <InstantsPanel
                  isLoading={false}
                  instants={instants}
                  search={instantSearch}
                  playback={instantPlayback}
                  onSearchChange={onInstantSearchChange}
                  onTrigger={onTriggerInstant}
                />
              </div>
            </ConsolePanel>
            <ConsolePanel title="Mixer" eyebrow="Program mix">
              <div className="console-mixer">
                <RadioMixerChannel
                  label="Music"
                  channel={mixer.song}
                  onVolumeChange={onSongVolumeChange}
                  onToggleMuted={onToggleSongMuted}
                />
                <RadioMixerChannel
                  label="Cartwall"
                  channel={mixer.instants}
                  onVolumeChange={onInstantVolumeChange}
                  onToggleMuted={onToggleInstantMuted}
                />
                <RadioMixerChannel
                  label="Output"
                  channel={mixer.main}
                  onVolumeChange={onMainVolumeChange}
                />
              </div>
              {(mixer.error || mixer.saving) && (
                <p
                  role={mixer.error ? "alert" : "status"}
                  className="px-3 py-2 text-[10px] text-accent-yellow"
                >
                  {mixer.error || "Applying mix…"}
                </p>
              )}
            </ConsolePanel>
            <details
              className="console-panel console-recovery"
              aria-label="Recovery controls"
            >
              <summary>Recovery & session</summary>
              <div className="console-recovery-content">
                <strong>
                  {recovery?.automation?.filler.ready
                    ? "Recovery playlist active"
                    : recovery?.connection === "unavailable"
                      ? "Engine unavailable"
                      : recovery?.preparedVersion
                        ? "Prepared for next session"
                        : "No prepared recovery playlist"}
                </strong>
                <p>
                  Starting binds the prepared playlist. Stopping clears program
                  audio and the binding.
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    size="xs"
                    variant="secondary"
                    onClick={() => void commandRecovery("start")}
                    disabled={
                      recoveryBusy ||
                      !recovery?.preparedVersion ||
                      recovery.connection !== "connected" ||
                      recovery.automation?.filler.ready
                    }
                  >
                    Start with fallback
                  </Button>
                  <Button
                    type="button"
                    size="xs"
                    variant="destructive"
                    onClick={() => void commandRecovery("stop")}
                    disabled={
                      recoveryBusy || !recovery?.automation?.filler.ready
                    }
                  >
                    Stop session
                  </Button>
                  <Link to="/radio-settings">Configure</Link>
                </div>
                {recoveryError && <p role="alert">{recoveryError}</p>}
              </div>
            </details>
          </aside>
        </div>
      </div>
      <PlaybackBar
        sequence={null as any}
        programSongPlayback={programSongPlayback}
        onChange={() => {}}
        onStopAllInstants={onStopAllInstants}
        logTransport={{
          isRunning: !!runningLog,
          canStart:
            !!activeLog?.publishedAt && !activeLog.lastStartedAt && !runningLog,
          canAdvance:
            !!runningLog &&
            Date.parse(runningLog.scheduledAt!) <= Date.now() &&
            currentLogIndex < runningLog.items.length - 1,
          busy: logBusy,
          label: runningLog
            ? Date.parse(runningLog.scheduledAt!) > Date.now()
              ? "Log armed for scheduled hour"
              : "Log automation running"
            : activeLog?.lastStartedAt
              ? "Log stopped"
              : activeLog?.publishedAt
                ? "Waiting for scheduled hour"
                : "Publish a log to start",
          onStart: () => void commandLog("start"),
          onStop: () => void commandLog("stop"),
          onAdvance: () => void commandLog("advance"),
        }}
      />
    </div>
  );
};

function RadioMixerChannel({
  label,
  channel,
  onVolumeChange,
  onToggleMuted,
}: {
  label: string;
  channel: RadioMixerChannelState;
  onVolumeChange: (value: number) => void;
  onToggleMuted?: () => void;
}) {
  const db = faderToDb(channel.volume);
  const level = Number.isFinite(db) ? `${db.toFixed(1)} dB` : "-∞ dB";
  const peakPercent = `${Math.max(0, Math.min(100, channel.peak * 100))}%`;
  return (
    <section className="console-channel" aria-label={`${label} mixer channel`}>
      <div className="console-channel-label">{label}</div>
      <div className="console-channel-db">{level}</div>
      <input
        type="range"
        min={0}
        max={1}
        step={0.01}
        value={channel.volume}
        onChange={(event) => onVolumeChange(Number(event.target.value))}
        aria-label={`${label} level`}
      />
      <div
        className="console-meter"
        role="meter"
        aria-label={`${label} live peak`}
        aria-valuenow={Math.max(0, Math.min(100, channel.peak * 100))}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <span style={{ width: peakPercent }} />
      </div>
      {onToggleMuted ? (
        <button
          type="button"
          onClick={onToggleMuted}
          aria-pressed={channel.muted === true}
        >
          {channel.muted ? "MUTED" : "MUTE"}
        </button>
      ) : (
        <span className="console-eyebrow text-center mt-2">Master</span>
      )}
    </section>
  );
}

function formatTime(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function formatUptime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}
