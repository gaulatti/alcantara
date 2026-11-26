import { TooltipButton } from "./BleeckerButtons";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Select } from "@gaulatti/bleecker";
import { apiUrl } from "../utils/apiBaseUrl";
import {
  List,
  Plus,
  ArrowUp,
  ArrowDown,
  Trash2,
  ListPlus,
} from "lucide-react";
import { ConsolePanel } from "./ConsoleSurface";
import { Link } from "react-router";
import type {
  ProgramSongPlaybackState,
  ProgramSongQueueEntry,
  SongCatalogItem,
  InstantItem,
} from "../models/broadcast";
import { ProgramSongSequenceEditor } from "./editors/ProgramSongSequenceEditor";
import { PlayNextQueue } from "./PlayNextQueue";
import {
  normalizeProgramSongSequence,
  createProgramSongSequence,
  type ProgramSongSequence,
} from "../utils/programSequence";
import { RadioOutputPlayer } from "./RadioOutputPlayer";
import { PlaybackBar } from "./PlaybackBar";
import { useRadioMonitor } from "./RadioMonitor";
import { HoldButton } from "./radio-desk/HoldButton";
import { OutputReading } from "./radio-desk/OutputReading";
import type { OnAirInput } from "./radio-desk/onAir";
import { LiveOnAirStrip } from "./radio-desk/OnAirStrip";
import { PlaySongNow } from "./radio-desk/PlaySongNow";
import { PlayoutMode } from "./radio-desk/PlayoutMode";
import { Meter } from "./radio-desk/primitives";
import { RadioTransport } from "./radio-desk/RadioTransport";
import {
  nextUp,
  onAirLeaf,
  rotationLeaves,
  type NextUpSong,
} from "./radio-desk/songs";
import { InstantsPanel } from "./panels";
import { dbToFader, faderToDb } from "../utils/audioTaper";
import { engineUnavailableLabel } from "../utils/palazzoReason";
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
  /** The live level and its held peak from ProgramAudioMeterLevels (#298); the meter shows them when given. */
  vu?: number;
  peakHold?: number;
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
    monitorAudioUrl?: string;
    stream: StreamStatus;
    palazzo: PalazzoStatus;
    output: OutputConfidence;
    logs: FlightSequence[];
    recovery: RecoveryStatus;
  };
  programId: string;
  playoutError?: string | null;
  songSequence: any;
  /** The rotation could not be read: show the error, never the empty rotation (the rotation was not loaded). */
  rotationLoadError?: boolean;
  onRetryRotation?: () => void;
  songQueue: ProgramSongQueueEntry[];
  songCatalog: SongCatalogItem[];
  programSongPlayback: ProgramSongPlaybackState | null;
  onSaveSongSequence: (seq: any) => Promise<void> | void;
  onTakeSelection?: (seq: ProgramSongSequence) => Promise<void> | void;
  onQueueSong: (itemId: string) => Promise<void> | void;
  onRemoveQueuedSong: (entryId: string) => Promise<void> | void;
  onReorderSongQueue: (entryIds: string[]) => Promise<void> | void;
  onTakeOffAir: () => Promise<void>;
  /** Puts a library song on air now, without changing the rotation (#298). */
  onPlaySongNow?: (song: SongCatalogItem) => Promise<void> | void;
  instants: InstantItem[];
  instantSearch: string;
  onInstantSearchChange: (v: string) => void;
  onTriggerInstant: (id: number) => void;
  onStopAllInstants: () => void;
  /** The last refused instant or Stop all (gaulatti/alcantara#253). */
  instantError?: string | null;
  /** Why the cartwall's instants did not load; shown with a retry. */
  instantsLoadError?: string | null;
  onRetryInstants?: () => void;
  /** Why the song library did not load; shown with a retry. */
  songCatalogLoadError?: string | null;
  onRetrySongCatalog?: () => void;
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
  /** Why there is no engine, when the backend says (#257); unknown values are ignored. */
  reason?: string | null;
  /**
   * Palazzo's playout (Liquidsoap), from its own state: down means Palazzo answers but nothing can air. Absent from
   * an older backend, null until Palazzo has said.
   */
  playout?: "up" | "down" | null;
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

/** The command failures the Radio desk keeps for this session, newest first (gaulatti/alcantara#707). */
const SESSION_LOG_LIMIT = 20;

/** Why a rundown cue was not aired, as the as-run logged it (gaulatti/alcantara#726). */
function notAiredReason(reason: string | null): string {
  if (reason === "engine_unavailable")
    return "not aired, the engine was unavailable";
  // The airing walk's W3: a fixed start passed over the cue.
  if (reason === "fixed_start") return "not aired, cut by a fixed start";
  return reason ? `not aired (${reason})` : "not aired";
}

/** Why the desk refuses what would be accepted and not air while Palazzo's playout is down. */
const PLAYOUT_DOWN_REASON = "Playout down: nothing can air";

/** The engine chip when the console cannot reach the Alcántara server at all (Dot's recovery walk). */
const SERVER_UNREACHABLE_LABEL = "Can't reach the Alcántara server";

/** The Recovery & session headline for a recovery status the console has read. */
function recoveryHeadline(recovery: RecoveryStatus | null): string {
  return recovery?.automation?.filler.ready
    ? "Recovery playlist active"
    : recovery?.connection === "unavailable"
      ? "Engine unavailable"
      : recovery?.preparedVersion
        ? "Prepared for next session"
        : "No prepared recovery playlist";
}

export const RadioPanel: React.FC<RadioPanelProps> = ({
  fixtureData,
  programId,
  playoutError,
  songSequence,
  rotationLoadError = false,
  onRetryRotation,
  songQueue,
  onSaveSongSequence,
  onTakeSelection,
  onQueueSong,
  onRemoveQueuedSong,
  onReorderSongQueue,
  onTakeOffAir,
  onPlaySongNow,
  songCatalog,
  programSongPlayback,
  instants,
  instantSearch,
  onInstantSearchChange,
  onTriggerInstant,
  onStopAllInstants,
  instantError = null,
  instantsLoadError = null,
  onRetryInstants,
  songCatalogLoadError = null,
  onRetrySongCatalog,
  instantPlayback,
  mixer,
  onSongVolumeChange,
  onInstantVolumeChange,
  onMainVolumeChange,
  onToggleSongMuted,
  onToggleInstantMuted,
}) => {
  const rotation = normalizeProgramSongSequence(songSequence) ?? {
    ...createProgramSongSequence("manual"),
    activeItemId: null,
  };
  const runRotation = async (action: () => Promise<void> | void) => {
    setQueueError(null);
    try {
      await action();
    } catch (cause) {
      setQueueError(
        cause instanceof Error ? cause.message : "Rotation command failed",
      );
    }
  };
  const [addingFillers, setAddingFillers] = useState(false);
  const [stream, setStream] = useState<StreamStatus | null>(
    fixtureData?.stream ?? null,
  );
  const [palazzo, setPalazzo] = useState<PalazzoStatus | null>(
    fixtureData?.palazzo ?? null,
  );
  // Until the first engine status answers, the engine's state is unknown, not unavailable: a fresh desk (or a page
  // reload) would otherwise read "Engine unavailable" for a round trip (#734 walk). Any answer, a failed one
  // included, ends the wait.
  const [palazzoAnswered, setPalazzoAnswered] = useState(!!fixtureData);
  // The console cannot reach the Alcántara server at all, as opposed to the server answering that the engine is down.
  const [serverUnreachable, setServerUnreachable] = useState(false);
  const [addSongId, setAddSongId] = useState("");
  const [logBusy, setLogBusy] = useState(false);
  const [logLoadError, setLogLoadError] = useState<string | null>(null);
  // A command failure shows as the desk's alert and is kept in this session's log; the alert clears when the
  // engine reconnects, the log entry stays (gaulatti/alcantara#707).
  const [queueError, setQueueErrorState] = useState<string | null>(null);
  // The last rundown command's result, so Advance, Stop and Start answer on screen.
  const [queueStatus, setQueueStatus] = useState<string | null>(null);
  const [sessionLog, setSessionLog] = useState<
    Array<{ at: number; message: string; count: number }>
  >([]);
  const setQueueError = (message: string | null) => {
    setQueueErrorState(message);
    if (message)
      setSessionLog((entries) =>
        // The same failure again is one line with a count, not a second line.
        entries[0]?.message === message
          ? [
              { at: Date.now(), message, count: entries[0].count + 1 },
              ...entries.slice(1),
            ]
          : [{ at: Date.now(), message, count: 1 }, ...entries].slice(
              0,
              SESSION_LOG_LIMIT,
            ),
      );
  };
  const [output, setOutput] = useState<OutputConfidence | null>(
    fixtureData?.output ?? null,
  );
  const [logs, setLogs] = useState<FlightSequence[]>(fixtureData?.logs ?? []);
  const [recovery, setRecovery] = useState<RecoveryStatus | null>(
    fixtureData?.recovery ?? null,
  );
  const [recoveryBusy, setRecoveryBusy] = useState(false);
  const [recoveryError, setRecoveryError] = useState<string | null>(null);
  // A failed recovery status read keeps the last known state and says it is unavailable (Dot's recovery walk).
  const [recoveryUnavailable, setRecoveryUnavailable] = useState(false);

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

  // A program switch hands this instance the new programId for one render before control.tsx swaps in its loading
  // screen (Wakko's #738 review). An engine status that answers late for the program before must not land here.
  const currentProgramId = useRef(programId);
  currentProgramId.current = programId;
  const fetchPalazzoStatus = useCallback(async () => {
    let next: PalazzoStatus | null = null;
    let unreachable = false;
    try {
      const res = await fetch(
        apiUrl(`/radio/${encodeURIComponent(programId)}/palazzo-status`),
      );
      if (res.ok) next = (await res.json()) || null;
    } catch {
      next = null;
      unreachable = true;
    }
    if (currentProgramId.current !== programId) return;
    setPalazzo(next);
    setPalazzoAnswered(true);
    setServerUnreachable(unreachable);
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
        cause instanceof Error ? cause.message : "Rundowns unavailable",
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
      if (!response.ok) throw new Error(`recovery status ${response.status}`);
      setRecovery(await response.json());
      setRecoveryUnavailable(false);
    } catch {
      // The last known status stays on screen; the panel says it is unavailable.
      setRecoveryUnavailable(true);
    }
  }, [programId]);

  // One recovery command at a time: a second start or stop while one is on its way sends nothing
  // (gaulatti/alcantara#693 review). A ref, so two calls from one render cannot both pass.
  const recoveryInFlight = useRef(false);
  const commandRecovery = async (action: "start" | "stop") => {
    if (recoveryInFlight.current) return;
    recoveryInFlight.current = true;
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
      recoveryInFlight.current = false;
      setRecoveryBusy(false);
    }
  };

  useEffect(() => {
    if (fixtureData) return;
    setStream(null);
    setPalazzo(null);
    setPalazzoAnswered(false);
    setServerUnreachable(false);
    setOutput(null);
    setLogs([]);
    setRecovery(null);
    setRecoveryUnavailable(false);
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
    setQueueStatus(null);
    try {
      if (action === "stop") await stopFlight(programId);
      else if (action === "advance") await goFlight(programId);
      /* v8 ignore start -- the rundown start control is disabled in the timed block (canStart is always false there), so this start path cannot be reached */
      else if (activeLog) {
        await activateFlightSequence(programId, activeLog.id);
        await startFlight(programId);
      }
      /* v8 ignore stop */
      // Until the engine confirms (its telemetry is fresh and it is ready), the command is only sent: say so.
      const confirmed = engineReady && programSongPlayback?.telemetryStale !== true;
      setQueueStatus(
        !confirmed
          ? "Sent: waiting for the engine to confirm."
          : action === "advance"
            ? "Advanced to the next cue."
            : action === "stop"
              ? "Rundown stopped."
              : "Rundown started.",
      );
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
    /* v8 ignore next -- every caller (cue controls and the add-song control) is rendered only when activeLog is set, so the closure always holds a log; defensive. */
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
    /* v8 ignore next -- moveCue is reached only from the cue controls, rendered inside the activeLog branch, so the closure always holds a log; this guard is defensive. */
    if (!activeLog) return;
    const items = [...activeLog.items];
    const [cue] = items.splice(index, 1);
    items.splice(target, 0, cue);
    void editLog(items);
  };
  const timedBlockOnAir =
    !!runningLog && Date.parse(runningLog.scheduledAt!) <= Date.now();
  const currentLogIndex = activeLog?.isRunning
    ? activeLog.items.findIndex((item) => item.id === activeLog.activeItemId)
    : -1;
  const engineReady =
    palazzo?.connection === "connected" || palazzo?.connection === "polling";

  const monitor = useRadioMonitor();
  const [findingSong, setFindingSong] = useState(false);
  // The engine coming back (#707): a command failure from while it was away no longer describes the desk.
  // Only a known "not connected" turning into "connected" counts: before the first status answer the engine's
  // state is unknown, so the first answer clears nothing.
  const engineKnownReady = palazzo ? engineReady : null;
  const engineWasReady = useRef<boolean | null>(null);
  useEffect(() => {
    if (engineKnownReady === null) return;
    if (engineKnownReady && engineWasReady.current === false)
      setQueueErrorState(null);
    engineWasReady.current = engineKnownReady;
  }, [engineKnownReady]);
  const leaves = rotationLeaves(rotation.items);
  const liveLeaf = onAirLeaf(
    leaves,
    programSongPlayback,
    rotation.activeItemId ?? null,
  );
  // A row shows "On air" only for a song the engine has confirmed (gaulatti/alcantara#609), never while
  // its playout is down (W5).
  const confirmedLiveLeaf =
    engineReady &&
    palazzo?.playout !== "down" &&
    programSongPlayback?.telemetryStale !== true
      ? liveLeaf
      : null;
  const next = nextUp({
    sequence: rotation,
    queue: songQueue,
    playback: programSongPlayback,
  });
  // Palazzo answers but its playout is down: automation still follows the connection, but the desk refuses
  // what would be accepted and not air (Take, Take now, Start with fallback). Stop stays available.
  const engineLabel = serverUnreachable
    ? SERVER_UNREACHABLE_LABEL
    : engineUnavailableLabel(palazzo);
  const playoutDown = engineReady && palazzo?.playout === "down";
  const onAirInput: Omit<OnAirInput, "outputUnverified"> = {
    playback: programSongPlayback,
    next,
    mode: rotation.mode,
    streamRunning: stream === null ? null : isLive,
    engine: {
      connected: engineReady,
      unknown: !palazzoAnswered,
      degraded: palazzo?.degraded === true,
      unavailableLabel: engineLabel,
      detail: palazzo?.detail ?? null,
    },
    monitor: monitor ? monitor.state : "unavailable",
    outputSilent: output?.state === "silent",
    outputAudible: output?.state === "audible",
    // D7: the desk knows of an instant airing and of a log block on air. Live input and scene audio are not reported
    // to it, so it can never rule them out: it says "active" or "unknown", never "none".
    otherAudio:
      timedBlockOnAir ||
      Object.values(instantPlayback).some(
        (instant) => instant.endsAtMs === null || instant.endsAtMs > Date.now(),
      )
        ? "active"
        : "unknown",
    playoutDown,
    rotationEnded: rotation.mode === "manual" && typeof rotation.endedAt === "number",
  };
  const recoveryControlsRef = useRef<HTMLDetailsElement>(null);
  const openRecoveryControls = () => {
    const controls = recoveryControlsRef.current;
    if (!controls) return;
    controls.open = true;
    controls.scrollIntoView({ block: "nearest" });
  };
  const takeRotationSong = async (itemId: string) => {
    const selection = { ...rotation, activeItemId: itemId, startedAt: Date.now() };
    if (onTakeSelection) await onTakeSelection(selection);
    else await onSaveSongSequence(selection);
  };
  const takeNext = (song: NextUpSong) => takeRotationSong(song.itemId);

  useEffect(() => {
    const onSlash = (event: KeyboardEvent) => {
      if (event.key !== "/" || event.ctrlKey || event.metaKey || event.altKey)
        return;
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable ||
          /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))
      )
        return;
      event.preventDefault();
      setFindingSong(true);
    };
    window.addEventListener("keydown", onSlash);
    return () => window.removeEventListener("keydown", onSlash);
  }, []);

  return (
    <div className="broadcast-console radio-console" data-console="radio">
      <LiveOnAirStrip input={onAirInput} output={output} programId={programId} />
      <div className="radio-console-scroll">
        <div className="radio-workspace">
          <ConsolePanel
            title={timedBlockOnAir ? "On-air rundown" : "Continuous fillers"}
            className="radio-rundown"
            actions={
              <div className="flex items-center gap-3">
                {!timedBlockOnAir && (
                  <Button
                    type="button"
                    size="xs"
                    variant="secondary"
                    onClick={() => setAddingFillers((value) => !value)}
                  >
                    <Plus size={13} />{" "}
                    {addingFillers ? "Done adding" : "Add fillers"}
                  </Button>
                )}
                <Link
                  to="/flight"
                  className="inline-flex items-center gap-1 text-sm"
                >
                  <List size={14} /> Prepare rundown
                </Link>
              </div>
            }
          >
            <div className="console-log-summary flex flex-wrap items-center justify-between gap-3">
              {/* A 12rem basis lets the playout modes wrap below on a phone instead of squeezing this text
                  into a one-word column. */}
              <div className="min-w-0 flex-[1_1_12rem]">
                {timedBlockOnAir && activeLog ? (
                  <>
                    <strong>{activeLog.name}</strong>
                    <small className="block">
                      {new Date(activeLog.scheduledAt!).toLocaleString()} ·{" "}
                      {/* timedBlockOnAir means activeLog is the running log. */}
                      {/* v8 ignore start -- timedBlockOnAir already requires scheduledAt <= now in the same render, so "ARMED" is unreachable here */}
                      {Date.parse(activeLog.scheduledAt!) > Date.now()
                        ? "ARMED"
                        : "ON AIR"}{" "}
                      {/* v8 ignore stop */}
                      · Revision {activeLog.revision}
                    </small>
                  </>
                ) : (
                  <>
                    <strong>24/7 rotation</strong>
                    <small className="block">
                      No hourly log required · {rotation.items.length} songs
                      {rotation.mode === "shuffle"
                        ? " · Shuffle pool; row order is not the next-song order"
                        : ""}
                    </small>
                    {nextLog && (
                      <small className="block">
                        Next timed block: {nextLog.name} ·{" "}
                        {new Date(nextLog.scheduledAt!).toLocaleString()}
                      </small>
                    )}
                  </>
                )}
              </div>
              {timedBlockOnAir ? (
                <span className="console-count">{`${activeLog!.items.length} events`}</span>
              ) : (
                <PlayoutMode
                  sequence={rotation}
                  activeItemId={liveLeaf?.id ?? null}
                  playing={programSongPlayback?.isPlaying === true}
                  onChange={(nextSequence) => {
                    void Promise.resolve(onSaveSongSequence(nextSequence)).catch(
                      (cause) =>
                        setQueueError(
                          cause instanceof Error
                            ? cause.message
                            : "Rotation was not changed",
                        ),
                    );
                  }}
                />
              )}
            </div>
            {(playoutError || queueError || logLoadError) && (
              <p role="alert" className="px-4 py-3 text-sm text-terracotta">
                {playoutError || queueError || logLoadError}
              </p>
            )}
            {queueStatus && !queueError && !playoutError && !logLoadError ? (
              <p role="status" className="px-4 py-3 text-sm text-text-secondary">
                {queueStatus}
              </p>
            ) : null}
            {sessionLog.length > 0 ? (
              <details
                aria-label="Session log"
                className="px-4 pb-3 text-xs text-text-secondary"
              >
                <summary>Session log ({sessionLog.length})</summary>
                <ol className="mt-1 space-y-0.5">
                  {sessionLog.map((entry, index) => (
                    // One line per entry, its time first: the alert above stays the only place the failure
                    // text stands alone.
                    <li key={`${entry.at}-${index}`}>
                      {`${new Date(entry.at).toLocaleTimeString()} · ${entry.message}${entry.count > 1 ? ` (×${entry.count})` : ""}`}
                    </li>
                  ))}
                </ol>
              </details>
            ) : null}
            {songCatalogLoadError && (
              <div
                role="alert"
                className="flex flex-wrap items-center gap-2 px-4 py-3 text-sm text-terracotta"
              >
                <span>Song library did not load: {songCatalogLoadError}</span>
                {onRetrySongCatalog && (
                  <Button
                    type="button"
                    size="xs"
                    variant="secondary"
                    onClick={onRetrySongCatalog}
                  >
                    Retry song library
                  </Button>
                )}
              </div>
            )}
            <div className="radio-rundown-body">
              {timedBlockOnAir && activeLog ? (
                <ol className="console-log" aria-label="On-air rundown">
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
                    // gaulatti/alcantara#726: a cue the as-run logged as not aired is skipped, never played.
                    const notAired = activeLog.cueOutcomes?.find(
                      (outcome) => outcome.cueId === cue.id,
                    );
                    const played = index < currentLogIndex && !notAired;
                    return (
                      <li
                        key={cue.id}
                        className="console-log-row"
                        data-active={active}
                        data-played={played}
                        data-skipped={!!notAired}
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
                            {cue.isFiller ? " · Filler" : ""}
                            {cue.voiceTrackInstantId ? " · Voice track" : ""}
                          </small>
                        </div>
                        <span className="tabular-nums text-xs text-text-secondary">
                          {song?.durationMs ? formatTime(song.durationMs) : "—"}
                        </span>
                        {notAired && !active && !next ? (
                          <span
                            className="console-eyebrow"
                            title={notAiredReason(notAired.reason)}
                            aria-label={`Skipped: ${notAiredReason(notAired.reason)}`}
                          >
                            SKIPPED
                          </span>
                        ) : (
                          <span className="console-eyebrow">
                            {active
                              ? "NOW"
                              : next
                                ? "NEXT"
                                : played
                                  ? "PLAYED"
                                  : String(index + 1).padStart(2, "0")}
                          </span>
                        )}
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
                <div className="flex h-full min-h-0 flex-col">
                  {songQueue.length > 0 && (
                    <PlayNextQueue
                      queue={songQueue}
                      sequence={rotation}
                      activeQueueEntryId={programSongPlayback?.queueEntryId}
                      onRemove={onRemoveQueuedSong}
                      onReorder={onReorderSongQueue}
                    />
                  )}
                  {rotationLoadError ? (
                    <div role="alert" className="flex flex-1 flex-col items-center justify-center gap-3 px-4 py-16 text-center">
                      <p className="text-sm font-medium text-text-primary">Couldn't load the rotation</p>
                      <p className="text-xs text-text-secondary">The backend did not answer. The rotation will load again once it does.</p>
                      {onRetryRotation ? <Button variant="secondary" onClick={onRetryRotation}>Retry</Button> : null}
                    </div>
                  ) : (
                    <ProgramSongSequenceEditor
                      sequence={rotation}
                      songCatalog={songCatalog}
                      programSongPlayback={programSongPlayback}
                      onChange={(next) => {
                        void Promise.resolve(onSaveSongSequence(next)).catch(
                          (cause) =>
                            setQueueError(
                              cause instanceof Error
                                ? cause.message
                                : "Rotation was not changed",
                            ),
                        );
                      }}
                      onTakeSelection={
                        onTakeSelection
                          ? (next) =>
                              runRotation(() => {
                                // A row's Take on air refuses while playout is down, as the transport's Take
                                // does: it would be accepted and not air (the airing walk's W4).
                                if (playoutDown)
                                  throw new Error(
                                    `${PLAYOUT_DOWN_REASON}. Nothing was taken.`,
                                  );
                                return onTakeSelection(next);
                              })
                          : undefined
                      }
                      onQueueItem={(itemId) => {
                        // The editor fires and forgets; a refused add is shown
                        // here, as a refused rotation change is (#194). A new
                        // add clears the last refusal first.
                        setQueueError(null);
                        void Promise.resolve(onQueueSong(itemId)).catch(
                          (cause) =>
                            setQueueError(
                              cause instanceof Error
                                ? cause.message
                                : "Play Next was not changed",
                            ),
                        );
                      }}
                      view={addingFillers ? "full" : "queue"}
                      rotationLabel="Filler rotation"
                      liveItemId={confirmedLiveLeaf?.id ?? null}
                      nextItemId={next?.itemId ?? null}
                    />
                  )}
                </div>
              )}
            </div>
            {timedBlockOnAir && activeLog && (
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
                    // The log is running here, so the song goes next.
                    const insert = currentLogIndex + 1;
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
                  Add next
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
              <OutputReading output={output} />
              {playoutDown ? (
                // Palazzo answers but its playout (Liquidsoap) is down: nothing airs, the recovery playlist
                // included, so the dead-air advice would not help. The cure is on the Palazzo host.
                <div
                  role="alert"
                  aria-label="Playout down"
                  className="mt-2 flex flex-col items-start gap-1.5 text-xs text-terracotta"
                >
                  <p>
                    Palazzo answers, but its playout engine (Liquidsoap) is
                    down: nothing can air, the recovery playlist included.
                    Restart playout on the Palazzo host or call engineering.
                  </p>
                </div>
              ) : output?.state === "silent" ? (
                // Dead air names the action that cures it (gaulatti/alcantara#694). Palazzo's
                // recovery playlist plays when the live queue runs dry, so the silent song comes off
                // air first.
                <div
                  role="alert"
                  aria-label="Dead air"
                  className="mt-2 flex flex-col items-start gap-1.5 text-xs text-terracotta"
                >
                  {mixer.song.muted ? (
                    // Walk part 4: the desk's own mute silenced the song. Taking it off air would leave the
                    // silence for good; unmuting cures it.
                    <>
                      <p>
                        Music is muted on this desk: the song plays, but nothing
                        reaches the air. Unmute it.
                      </p>
                      <Button
                        type="button"
                        size="xs"
                        variant="secondary"
                        onClick={onToggleSongMuted}
                      >
                        Unmute music
                      </Button>
                    </>
                  ) : mixer.song.volume === 0 || mixer.main.volume === 0 ? (
                    <p>
                      The {mixer.song.volume === 0 ? "Music" : "Output"} fader is
                      down on this desk: raise it to put the song back on air.
                    </p>
                  ) : !recovery || recovery.connection !== "connected" ? (
                    // The desk cannot say what recovery is ready, so it claims nothing about a playlist
                    // (gaulatti/alcantara#694 review).
                    <p>
                      Hold Stop to take the silent song off air. The recovery
                      status is unavailable: check the engine before relying on
                      the fallback.
                    </p>
                  ) : recovery.automation?.filler.ready ? (
                    <p>
                      Hold Stop to take the silent song off air. The recovery
                      playlist is bound and plays once the queue runs dry.
                    </p>
                  ) : recovery.preparedVersion ? (
                    <>
                      <p>
                        Hold Stop to take the silent song off air, then Start
                        with fallback.
                      </p>
                      <Button
                        type="button"
                        size="xs"
                        variant="secondary"
                        onClick={openRecoveryControls}
                      >
                        Go to recovery
                      </Button>
                    </>
                  ) : (
                    <>
                      <p>
                        Hold Stop to take the silent song off air. No recovery
                        playlist is prepared.
                      </p>
                      <Link to="/radio-settings">
                        Prepare a recovery playlist
                      </Link>
                    </>
                  )}
                </div>
              ) : null}
              <p className="mt-2 text-xs text-text-secondary">
                Palazzo mix level before Icecast.
              </p>
              <RadioOutputPlayer
                key={programId}
                {...(fixtureData?.monitorAudioUrl
                  ? { listenerUrl: fixtureData.monitorAudioUrl }
                  : { programId })}
              />
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
              className="radio-cartwall"
              actions={
                <HoldButton
                  label="Stop all sounders"
                  hint="Hold to stop every sounder (0.6 s)."
                  tone="danger"
                  onConfirm={onStopAllInstants}
                >
                  Hold · stop all
                </HoldButton>
              }
            >
              <div className="radio-cartwall-body">
                {instantError && (
                  <p
                    role="alert"
                    className="radio-cartwall-alert text-sm text-terracotta"
                  >
                    {instantError}
                  </p>
                )}
                {instantsLoadError && (
                  <div
                    role="alert"
                    className="radio-cartwall-alert flex flex-wrap items-center gap-2 text-sm text-terracotta"
                  >
                    <span>Cartwall did not load: {instantsLoadError}</span>
                    {onRetryInstants && (
                      <Button
                        type="button"
                        size="xs"
                        variant="secondary"
                        onClick={onRetryInstants}
                      >
                        Retry cartwall
                      </Button>
                    )}
                  </div>
                )}
                {/* A failed reload keeps the pads that loaded; the error is
                    shown alone only when there is nothing to play. */}
                {!(instantsLoadError && instants.length === 0) && (
                  <InstantsPanel
                    isLoading={false}
                    instants={instants}
                    search={instantSearch}
                    playback={instantPlayback}
                    onSearchChange={onInstantSearchChange}
                    onTrigger={onTriggerInstant}
                  />
                )}
              </div>
            </ConsolePanel>
            <ConsolePanel title="Mixer">
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
              ref={recoveryControlsRef}
              className="console-panel console-recovery"
              aria-label="Recovery controls"
            >
              <summary>Recovery & session</summary>
              <div className="console-recovery-content">
                <strong>
                  {recoveryUnavailable
                    ? "Recovery status unavailable"
                    : recoveryHeadline(recovery)}
                </strong>
                {recoveryUnavailable && recovery ? (
                  <p>Last known: {recoveryHeadline(recovery).toLowerCase()}.</p>
                ) : null}
                <p>
                  Starting binds the prepared playlist. Stopping clears program
                  audio and the binding.
                </p>
                {playoutDown ? (
                  <p className="text-terracotta">
                    {PLAYOUT_DOWN_REASON}, the recovery playlist included: Start
                    with fallback is unavailable until playout is back.
                  </p>
                ) : null}
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    size="xs"
                    variant="secondary"
                    onClick={() => void commandRecovery("start")}
                    disabled={
                      recoveryBusy ||
                      playoutDown ||
                      !recovery?.preparedVersion ||
                      recovery.connection !== "connected" ||
                      recovery.automation?.filler.ready
                    }
                  >
                    Start with fallback
                  </Button>
                  {/* Stopping the session clears program audio, so it is held like Stop and Stop all
                      (gaulatti/alcantara#693): a click only explains. */}
                  <HoldButton
                    label="Stop session"
                    hint="Hold to stop the session (0.6 s). Program audio stops."
                    tone="danger"
                    // Re-checked when the hold completes: the session may have stopped, or a command
                    // started, while the control was held.
                    onConfirm={() => {
                      if (!recoveryBusy && recovery?.automation?.filler.ready)
                        void commandRecovery("stop");
                    }}
                    disabled={
                      recoveryBusy || !recovery?.automation?.filler.ready
                    }
                  >
                    Hold · stop session
                  </HoldButton>
                  {/* Its keyboard focus ring is the global :focus-visible rule in app.css (#688), not a per-link style. */}
                  <Link to="/radio-settings">Configure</Link>
                </div>
                {recoveryError && <p role="alert">{recoveryError}</p>}
              </div>
            </details>
          </aside>
        </div>
      </div>
      {timedBlockOnAir ? (
      <PlaybackBar
        sequence={rotation}
        programSongPlayback={programSongPlayback}
        // Playout down confirms nothing either (W5): the bar holds its clock, as the strip does.
        engineUnconfirmed={!engineReady || playoutDown}
        onChange={(next) => {
          /* v8 ignore start -- PlaybackBar renders only in the timed block, where its sequence-change controls are hidden, so this save callback is never invoked */
          void Promise.resolve(onSaveSongSequence(next)).catch((cause) =>
            setQueueError(
              cause instanceof Error
                ? cause.message
                : "Rotation was not changed",
            ),
          );
        }}
        /* v8 ignore stop */
        onTakeSelection={
          onTakeSelection
            /* v8 ignore next -- PlaybackBar renders only in the timed block, where its take controls are hidden, so its take callback is never invoked */
            ? (next) => runRotation(() => onTakeSelection(next))
            : undefined
        }
        onTakeOffAir={() => runRotation(onTakeOffAir)}
        onStopAllInstants={onStopAllInstants}
        logTransport={
          timedBlockOnAir
            ? {
                isRunning: !!runningLog,
                // timedBlockOnAir requires a running log, so nothing is
                // waiting to start.
                canStart: false,
                canAdvance:
                  !!runningLog &&
                  Date.parse(runningLog.scheduledAt!) <= Date.now() &&
                  currentLogIndex < runningLog.items.length - 1,
                busy: logBusy,
                /* v8 ignore start -- timedBlockOnAir already requires scheduledAt <= now in the same render, so "armed" is unreachable here */
                label:
                  Date.parse(runningLog!.scheduledAt!) > Date.now()
                    ? "Rundown armed for scheduled start"
                    : "Rundown automation running",
                /* v8 ignore stop */
                onStart: () => void commandLog("start"),
                onStop: () => void commandLog("stop"),
                onAdvance: () => void commandLog("advance"),
              }
            /* v8 ignore next -- PlaybackBar only renders in the timed block, which always passes logTransport, so this false arm cannot be reached */
            : undefined
        }
      />
      ) : (
        <RadioTransport
          next={next}
          onTake={takeNext}
          onTakeOffAir={onTakeOffAir}
          keysEnabled={!findingSong}
          engineUnavailable={
            !engineReady
              ? engineLabel
              : playoutDown
                ? PLAYOUT_DOWN_REASON
                : null
          }
          confirmedItemId={confirmedLiveLeaf?.id ?? null}
          onListen={
            monitor
              ? () =>
                  monitor.state === "stopped"
                    ? void monitor.listen()
                    : monitor.stop()
              : undefined
          }
          listening={monitor?.state === "playing"}
        />
      )}
      <PlaySongNow
        open={findingSong}
        leaves={leaves}
        catalog={songCatalog}
        onClose={() => setFindingSong(false)}
        onCueNext={(leaf) => onQueueSong(leaf.id)}
        onTakeNow={async (candidate) => {
          if (playoutDown)
            throw new Error(`${PLAYOUT_DOWN_REASON}. Nothing was taken.`);
          if (candidate.leaf) return takeRotationSong(candidate.leaf.id);
          if (candidate.song && onPlaySongNow) return onPlaySongNow(candidate.song);
          throw new Error("Playing a library song now is not available here.");
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
        onKeyDown={(event) => {
          // Up and down move the fader one decibel, not one hundredth of its travel.
          if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
          event.preventDefault();
          const current = Number.isFinite(db) ? db : -80;
          const target = current + (event.key === "ArrowUp" ? 1 : -1);
          onVolumeChange(Math.max(0, Math.min(1, dbToFader(target))));
        }}
        aria-label={`${label} level`}
      />
      <Meter
        label={`${label} live peak`}
        value={Math.max(0, Math.min(100, (channel.vu ?? channel.peak) * 100))}
        peak={channel.vu !== undefined ? Math.min(100, channel.peak * 100) : null}
        hold={
          channel.peakHold !== undefined
            ? Math.min(100, channel.peakHold * 100)
            : null
        }
        min={0}
        max={100}
        warnFrom={90}
      />
      {onToggleMuted ? (
        <TooltipButton
          type="button"
          onClick={onToggleMuted}
          aria-pressed={channel.muted === true}
        >
          {channel.muted ? "MUTED" : "MUTE"}
        </TooltipButton>
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
