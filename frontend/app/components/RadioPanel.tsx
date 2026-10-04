import { useCallback, useEffect, useState } from "react";
import { Button } from "@gaulatti/bleecker";
import { apiUrl } from "../utils/apiBaseUrl";
import { AlertTriangle, List, Plus, Radio } from "lucide-react";
import { ConsoleClock, ConsolePanel } from "./ConsoleSurface";
import { Link } from "react-router";
import type {
  ProgramSongPlaybackState,
  ProgramSongQueueEntry,
  SongCatalogItem,
  InstantItem,
} from "../models/broadcast";
import { PlaybackBar } from "./PlaybackBar";
import { InstantsPanel, PlaylistPanel, PlaylistSheetPanel } from "./panels";
import { faderToDb } from "../utils/audioTaper";
import { PlayNextQueue } from "./PlayNextQueue";
import { fetchFlightSequences } from "../services/flight";
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
  songSequence,
  songQueue,
  songCatalog,
  programSongPlayback,
  onSaveSongSequence,
  onQueueSong,
  onRemoveQueuedSong,
  onReorderSongQueue,
  onTakeOffAir,
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
  const [playlistSheetOpen, setPlaylistSheetOpen] = useState(false);
  const [queueError, setQueueError] = useState<string | null>(null);
  const [output, setOutput] = useState<OutputConfidence | null>(
    fixtureData?.output ?? null,
  );
  const [logs, setLogs] = useState<FlightSequence[]>(fixtureData?.logs ?? []);
  const [rundownTab, setRundownTab] = useState<"playlist" | "log">("playlist");
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
        ),
        fetchFlightSequences(programId),
      ]);
      setOutput(confidenceResponse.ok ? await confidenceResponse.json() : null);
      setLogs(sequences.filter((sequence) => sequence.scheduledAt !== null));
    } catch {
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
    const airPlanInterval = setInterval(fetchAirPlan, 8000);
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

  const handleTakeSelection = useCallback(
    async (seq: any) => {
      const wasPlaying = programSongPlayback?.isPlaying === true;
      await onSaveSongSequence(seq);
      const item = seq?.items?.find((i: any) => i.id === seq?.activeItemId);
      if (!item?.audioUrl) return;
      if (
        !wasPlaying &&
        (seq?.mode === "autoplay" || seq?.mode === "shuffle")
      ) {
        return;
      }
      await fetch(apiUrl(`/radio/${encodeURIComponent(programId)}/song`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          audioUrl: item.audioUrl,
          title: item?.title,
          artist: item?.artist,
          coverUrl: item?.coverUrl,
          durationMs: item?.durationMs,
          songId: item?.songId,
        }),
      });
    },
    [onSaveSongSequence, programId, programSongPlayback?.isPlaying],
  );

  const handleQueueSong = useCallback(
    async (itemId: string) => {
      setQueueError(null);
      try {
        await onQueueSong(itemId);
      } catch {
        setQueueError("The song was not added to Play Next. Try again.");
      }
    },
    [onQueueSong],
  );

  const isLive = stream?.running === true;
  const activeLog = logs.find((sequence) => sequence.isRunning) ?? null;
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
  const currentLogIndex =
    activeLog?.items.findIndex((item) => item.id === activeLog.activeItemId) ??
    -1;
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
  const playingQueueIndex = songQueue.findIndex(
    (entry) => entry.id === programSongPlayback?.queueEntryId,
  );
  const nextQueueEntry = songQueue[playingQueueIndex + 1];
  const nextQueuedSong = nextQueueEntry
    ? songSequence?.items?.find(
        (item: any) => item.id === nextQueueEntry.itemId,
      )
    : null;
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
            title="Rundown"
            eyebrow="Playout"
            className="radio-rundown"
            actions={
              <Button
                type="button"
                size="xs"
                variant="secondary"
                onClick={() => setPlaylistSheetOpen(true)}
              >
                <Plus size={13} /> Add songs
              </Button>
            }
          >
            <div className="flex items-center justify-between gap-2 border-b border-sand/15 px-4">
              <div
                className="console-tabs"
                role="tablist"
                aria-label="Rundown source"
                onKeyDown={(event) => {
                  if (
                    !["ArrowLeft", "ArrowRight", "Home", "End"].includes(
                      event.key,
                    )
                  )
                    return;
                  event.preventDefault();
                  const next =
                    event.key === "Home"
                      ? "playlist"
                      : event.key === "End"
                        ? "log"
                        : rundownTab === "playlist"
                          ? "log"
                          : "playlist";
                  setRundownTab(next);
                  (
                    event.currentTarget.querySelector(
                      next === "playlist"
                        ? "#music-rundown-tab"
                        : "#clocked-rundown-tab",
                    ) as HTMLButtonElement
                  )?.focus();
                }}
              >
                <button
                  type="button"
                  role="tab"
                  id="music-rundown-tab"
                  tabIndex={rundownTab === "playlist" ? 0 : -1}
                  aria-selected={rundownTab === "playlist"}
                  aria-controls="music-rundown"
                  onClick={() => setRundownTab("playlist")}
                >
                  Music playlist
                </button>
                <button
                  type="button"
                  role="tab"
                  id="clocked-rundown-tab"
                  tabIndex={rundownTab === "log" ? 0 : -1}
                  aria-selected={rundownTab === "log"}
                  aria-controls="clocked-rundown"
                  onClick={() => setRundownTab("log")}
                >
                  Clocked log{activeLog ? " · running" : ""}
                </button>
              </div>
              <span className="console-count">
                {rundownTab === "playlist"
                  ? `${songSequence?.items?.length ?? 0} tracks`
                  : `${activeLog?.items.length ?? 0} cues`}
              </span>
            </div>
            {rundownTab === "playlist" ? (
              <div
                className="radio-rundown-body"
                role="tabpanel"
                id="music-rundown"
                aria-labelledby="music-rundown-tab"
              >
                <PlayNextQueue
                  queue={songQueue}
                  sequence={songSequence}
                  activeQueueEntryId={programSongPlayback?.queueEntryId}
                  onRemove={onRemoveQueuedSong}
                  onReorder={onReorderSongQueue}
                />
                {queueError && (
                  <p role="alert" className="px-3 py-2 text-xs text-terracotta">
                    {queueError}
                  </p>
                )}
                <div className="console-playlist">
                  <PlaylistPanel
                    sequence={songSequence}
                    songCatalog={songCatalog}
                    programSongPlayback={programSongPlayback}
                    onChange={(seq) => {
                      void onSaveSongSequence(seq);
                    }}
                    onTakeSelection={handleTakeSelection}
                    onQueueItem={handleQueueSong}
                  />
                </div>
              </div>
            ) : (
              <div
                className="radio-rundown-body"
                role="tabpanel"
                id="clocked-rundown"
                aria-labelledby="clocked-rundown-tab"
              >
                <div className="console-log-summary flex justify-between gap-2">
                  <span>{activeLog?.name || "No clocked log running"}</span>
                  <Link
                    to="/radio-log"
                    className="inline-flex items-center gap-1"
                  >
                    <List size={12} /> Open logs
                  </Link>
                </div>
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
                      const active = cue.id === activeLog.activeItemId;
                      const next =
                        currentLogIndex >= 0 && index === currentLogIndex + 1;
                      return (
                        <li
                          key={cue.id}
                          className="console-log-row"
                          data-active={active}
                        >
                          <time>
                            {cue.clockOffsetSeconds === undefined
                              ? "Follows"
                              : activeLog.scheduledAt
                                ? new Date(
                                    Date.parse(activeLog.scheduledAt) +
                                      cue.clockOffsetSeconds * 1000,
                                  ).toLocaleTimeString(undefined, {
                                    hour12: false,
                                  })
                                : `+${formatTime(cue.clockOffsetSeconds * 1000)}`}
                          </time>
                          <div className="min-w-0">
                            <span className="block truncate font-semibold">
                              {cue.kind === "playSong"
                                ? (song?.title ?? "Unavailable song")
                                : cue.kind === "instant"
                                  ? (clip?.name ?? "Unavailable clip")
                                  : "Stop audio"}
                            </span>
                            <small>
                              {cue.kind === "playSong"
                                ? song?.artist
                                : cue.kind === "instant"
                                  ? "Audio clip"
                                  : "Transport command"}
                            </small>
                          </div>
                          <span className="console-eyebrow">
                            {active
                              ? "NOW"
                              : next
                                ? "NEXT"
                                : String(index + 1).padStart(2, "0")}
                          </span>
                        </li>
                      );
                    })}
                  </ol>
                ) : (
                  <div className="console-empty">
                    {nextLog
                      ? `Next published hour: ${new Date(nextLog.scheduledAt!).toLocaleString()}`
                      : "No published hour is queued."}
                  </div>
                )}
              </div>
            )}
            <div className="console-log-summary flex items-center justify-between gap-3">
              <span className="truncate">
                {nextQueuedSong
                  ? `Play next · ${nextQueuedSong.title}`
                  : nextQueueEntry
                    ? "Play next · Unavailable playlist item"
                    : "Play Next is empty"}
              </span>
              <span className="shrink-0">{songQueue.length} queued</span>
            </div>
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
        sequence={songSequence}
        programSongPlayback={programSongPlayback}
        sceneQuickActions={[]}
        onChange={(seq) => {
          void onSaveSongSequence(seq);
        }}
        onTakeSelection={handleTakeSelection}
        onTakeOffAir={onTakeOffAir}
        onStopAllInstants={onStopAllInstants}
        onStageScene={() => {}}
        onTakeScene={() => {}}
      />

      <PlaylistSheetPanel
        isOpen={playlistSheetOpen}
        onClose={() => setPlaylistSheetOpen(false)}
        sequence={songSequence}
        songCatalog={songCatalog}
        programSongPlayback={programSongPlayback}
        isSaving={false}
        onChange={(seq) => {
          void onSaveSongSequence(seq);
        }}
        onTakeSelection={handleTakeSelection}
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
