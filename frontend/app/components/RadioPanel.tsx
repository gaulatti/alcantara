import { useCallback, useEffect, useState } from "react";
import { Button, Panel } from "@gaulatti/bleecker";
import { apiUrl } from "../utils/apiBaseUrl";
import { AlertTriangle, List, Music2, Wifi, WifiOff, Radio } from "lucide-react";
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
  fixtureData?: { stream: StreamStatus; palazzo: PalazzoStatus; output: OutputConfidence; logs: FlightSequence[]; recovery: RecoveryStatus };
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
  state: 'unknown' | 'unavailable' | 'idle' | 'checking' | 'audible' | 'silent';
  expectedAudio: boolean;
  outputRms: number | null;
  lastSampleAt: string | null;
  quietForMs: number | null;
}
interface RecoveryStatus {
  preparedVersion: string | null;
  automation: { actualState: string; filler: { activeVersion: string | null; ready: boolean } } | null;
  connection: 'connected' | 'unavailable';
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
  const [stream, setStream] = useState<StreamStatus | null>(fixtureData?.stream ?? null);
  const [palazzo, setPalazzo] = useState<PalazzoStatus | null>(fixtureData?.palazzo ?? null);
  const [playlistSheetOpen, setPlaylistSheetOpen] = useState(false);
  const [queueError, setQueueError] = useState<string | null>(null);
  const [output, setOutput] = useState<OutputConfidence | null>(fixtureData?.output ?? null);
  const [logs, setLogs] = useState<FlightSequence[]>(fixtureData?.logs ?? []);
  const [mixerOpen, setMixerOpen] = useState(false);
  const [recovery, setRecovery] = useState<RecoveryStatus | null>(fixtureData?.recovery ?? null);
  const [recoveryBusy, setRecoveryBusy] = useState(false);
  const [recoveryError, setRecoveryError] = useState<string | null>(null);

  const fetchStreamStatus = useCallback(async () => {
    try {
      const res = await fetch(
        apiUrl(`/radio/${encodeURIComponent(programId)}/status`),
      );
      if (res.ok) setStream(await res.json());
    } catch {}
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
        fetch(apiUrl(`/radio/${encodeURIComponent(programId)}/output-confidence`)),
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
      const response = await fetch(apiUrl(`/radio/${encodeURIComponent(programId)}/recovery`));
      setRecovery(response.ok ? await response.json() : null);
    } catch { setRecovery(null); }
  }, [programId]);

  const commandRecovery = async (action: 'start' | 'stop') => {
    setRecoveryBusy(true); setRecoveryError(null);
    try {
      const response = await fetch(apiUrl(`/radio/${encodeURIComponent(programId)}/recovery/${action}`), { method: 'POST' });
      if (!response.ok) throw new Error(`Palazzo could not ${action} recovery (${response.status}).`);
      setRecovery(await response.json());
    } catch (cause) { setRecoveryError(cause instanceof Error ? cause.message : 'Recovery command failed.'); }
    finally { setRecoveryBusy(false); }
  };

  useEffect(() => {
    if (fixtureData) return;
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
  }, [fetchStreamStatus, fetchPalazzoStatus, fetchAirPlan, fetchRecovery, fixtureData]);

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
  const isPlaying =
    programSongPlayback?.isPlaying && programSongPlayback?.audioUrl;
  const progress = programSongPlayback?.durationMs
    ? Math.round(
        (programSongPlayback.currentTimeMs / programSongPlayback.durationMs) *
          100,
      )
    : 0;
  const activeLog = logs.find((sequence) => sequence.isRunning) ?? null;
  const nextLog = logs.filter((sequence) => sequence.publishedAt && !sequence.lastStartedAt && sequence.scheduledAt && Date.parse(sequence.scheduledAt) > Date.now()).sort((a, b) => Date.parse(a.scheduledAt!) - Date.parse(b.scheduledAt!))[0] ?? null;
  const currentLogIndex = activeLog?.items.findIndex((item) => item.id === activeLog.activeItemId) ?? -1;
  const outputTone = output?.state === 'silent' || output?.state === 'unavailable' ? 'border-red-400/50 bg-red-500/10 text-red-200' : output?.state === 'audible' ? 'border-emerald-400/40 bg-emerald-500/10 text-emerald-200' : 'border-amber-400/40 bg-amber-500/10 text-amber-200';
  const outputLabel = output?.state === 'audible' ? 'Output audio detected' : output?.state === 'silent' ? 'Expected audio is silent' : output?.state === 'unavailable' ? 'Palazzo output unavailable' : output?.state === 'idle' ? 'No program audio expected' : output?.state === 'checking' ? 'Checking output audio' : 'Output audio unverified';

  return (
    <div className="flex min-h-0 w-full flex-1 flex-col overflow-hidden bg-dark-sand text-text-primary">
      <div className="grid min-h-0 flex-1 grid-cols-1 overflow-y-auto lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.4fr)] lg:overflow-hidden">
        <div className="flex min-h-0 min-w-0 flex-col lg:overflow-y-auto">
          <div className="space-y-3 p-3 pb-0">
            <div role="status" className={`flex flex-wrap items-center justify-between gap-3 rounded-xl border px-4 py-3 ${outputTone}`}>
              <div className="flex items-center gap-2 text-sm font-semibold">{output?.state === 'silent' || output?.state === 'unavailable' ? <AlertTriangle size={17} /> : <Radio size={17} />}{outputLabel}</div>
              <span className="font-mono text-xs">{output?.lastSampleAt ? `Sample ${new Date(output.lastSampleAt).toLocaleTimeString()}` : 'No fresh level sample'}</span>
            </div>
            <section className="rounded-xl border border-sand/30 bg-sand/5 p-4" aria-label="On-air log">
              <div className="flex flex-wrap items-center justify-between gap-2"><div><p className="text-[10px] font-bold uppercase tracking-widest text-accent-blue">On-air log</p><h2 className="text-base font-semibold">{activeLog ? new Date(activeLog.scheduledAt!).toLocaleString(undefined, { hour: 'numeric', minute: '2-digit' }) : 'No clocked log running'}</h2></div><Link to="/radio-log" className="inline-flex items-center gap-1 rounded-lg border border-sand/30 px-3 py-1.5 text-xs font-semibold hover:bg-sand/10"><List size={14} /> Open logs</Link></div>
              {activeLog ? <div className="mt-3 space-y-1">{activeLog.items.slice(Math.max(0, currentLogIndex), Math.max(0, currentLogIndex) + 2).map((cue, index) => <div key={cue.id} className={`flex justify-between gap-3 rounded-lg px-3 py-2 text-xs ${index === 0 ? 'bg-accent-blue/15 font-bold' : 'bg-dark-sand/50 text-text-secondary'}`}><span className="truncate">{index === 0 ? 'NOW' : 'NEXT'} · {cue.kind === 'playSong' ? songCatalog.find((song) => song.id === cue.songId)?.title ?? 'Unavailable song' : cue.kind === 'instant' ? instants.find((clip) => clip.id === cue.instantId)?.name ?? 'Unavailable clip' : 'Stop audio'}</span><span className="shrink-0 font-mono">{cue.clockOffsetSeconds === undefined ? 'follows' : `+${Math.floor(cue.clockOffsetSeconds / 60).toString().padStart(2, '0')}:${(cue.clockOffsetSeconds % 60).toString().padStart(2, '0')}`}</span></div>)}</div> : <p className="mt-2 text-xs text-text-secondary">{nextLog ? `Next published hour: ${new Date(nextLog.scheduledAt!).toLocaleString()}` : 'No published hour is queued.'}</p>}
            </section>
          </div>
          <Panel
            title="On air"
            accent={isLive ? "#22c55e" : "#ef4444"}
            variant="monitor"
            className="min-h-0"
          >
            <div className="space-y-3">
              <div className="flex items-center justify-between rounded-xl border border-sand/30 bg-dark-sand/70 p-3">
                <div className="flex items-center gap-3">
                  {isLive ? (
                    <div className="flex items-center gap-2 text-green-400">
                      <span className="relative flex h-2.5 w-2.5">
                        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-green-400 opacity-75" />
                        <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-green-500" />
                      </span>
                      <Wifi className="h-4 w-4" />
                      <span className="text-sm font-bold tracking-wide">
                        STREAM CONNECTED
                      </span>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2 text-red-400">
                      <WifiOff className="h-4 w-4" />
                      <span className="text-sm font-bold tracking-wide">
                        OFFLINE
                      </span>
                    </div>
                  )}
                  {isLive && stream?.uptime != null && (
                    <span className="text-[11px] text-text-secondary font-mono">
                      {formatUptime(stream.uptime)}
                    </span>
                  )}
                </div>
                {palazzo && (
                  <div
                    className="flex flex-wrap items-center justify-end gap-2"
                    title={palazzo.detail ?? undefined}
                  >
                    {palazzo.connection === "connected" ||
                    palazzo.connection === "polling" ? (
                      <span
                        className={`flex items-center gap-1 text-[10px] font-mono font-bold tracking-wide px-1.5 py-0.5 rounded ${palazzo.degraded ? "bg-amber-400/10 text-amber-300" : "bg-green-400/10 text-green-400"}`}
                      >
                        <Radio className="h-3 w-3" />
                        PALAZZO{" "}
                        {palazzo.connection === "polling" ? "POLLING" : "LIVE"}
                        {palazzo.instanceId ? ` · ${palazzo.instanceId}` : ""}
                      </span>
                    ) : (
                      <span className="flex items-center gap-1 text-[10px] font-mono font-bold tracking-wide px-1.5 py-0.5 rounded bg-red-400/10 text-red-400">
                        <WifiOff className="h-3 w-3" />
                        PALAZZO{" "}
                        {palazzo.connection === "instance-mismatch" ||
                        palazzo.connection === "instance-conflict"
                          ? palazzo.connection === "instance-conflict"
                            ? "CONFLICT"
                            : "MISMATCH"
                          : "OFFLINE"}
                      </span>
                    )}
                    {palazzo.degraded && (
                      <span className="text-[10px] font-mono font-bold tracking-wide px-1.5 py-0.5 rounded bg-amber-400/10 text-amber-300">
                        DEGRADED
                      </span>
                    )}
                    {palazzo.lastEventAt && (
                      <span className="text-[11px] text-text-secondary font-mono">
                        {formatUptime(
                          Date.now() - Date.parse(palazzo.lastEventAt),
                        )}{" "}
                        ago
                      </span>
                    )}
                  </div>
                )}
              </div>

              <div className="rounded-xl border border-sand/30 bg-dark-sand/70 p-4">
                <p className="text-[10px] font-bold tracking-widest text-violet-300 mb-3 uppercase">
                  On Air
                </p>
                {isPlaying && programSongPlayback ? (
                  <div className="space-y-1">
                    <h2 className="text-lg font-bold text-text-primary truncate">
                      {programSongPlayback.title || "Unknown"}
                    </h2>
                    <p className="text-sm text-text-secondary">
                      {programSongPlayback.artist || "Unknown Artist"}
                    </p>
                    {programSongPlayback.introStatus === "degraded" ? (
                      <p className="text-xs font-medium text-amber-300">
                        Intro unavailable
                        {programSongPlayback.introFailureReason
                          ? `: ${programSongPlayback.introFailureReason}`
                          : ""}
                      </p>
                    ) : programSongPlayback.introStatus === "playing" ? (
                      <p className="text-xs font-medium text-violet-300">
                        Intro playing
                      </p>
                    ) : null}
                    {programSongPlayback.durationMs ? (
                      <div className="mt-3 space-y-1">
                        <div className="h-1.5 w-full rounded-full bg-sand/20 overflow-hidden">
                          <div
                            className="h-full rounded-full bg-gradient-to-r from-violet-500 to-emerald-400 transition-all duration-500"
                            style={{ width: `${Math.min(progress, 100)}%` }}
                          />
                        </div>
                        <div className="flex justify-between text-[10px] font-mono text-text-secondary">
                          <span>
                            {formatTime(programSongPlayback.currentTimeMs || 0)}
                          </span>
                          <span>
                            {formatTime(programSongPlayback.durationMs)}
                          </span>
                        </div>
                      </div>
                    ) : null}
                  </div>
                ) : (
                  <div className="py-3 text-center">
                    <Music2 className="h-10 w-10 mx-auto text-sand mb-2" />
                    <p className="text-sm text-text-secondary">
                      No track playing
                    </p>
                  </div>
                )}
              </div>
            </div>
          </Panel>
          <div className="space-y-3 p-3">
            <details className="rounded-xl border border-sand/30 bg-sand/5 p-4" aria-label="Recovery controls">
              <summary className="cursor-pointer text-xs font-semibold text-text-secondary">Recovery and session controls</summary>
              <div className="mt-3">
              <div className="flex flex-wrap items-center justify-between gap-2"><div><p className="text-[10px] font-bold uppercase tracking-widest text-text-secondary">Recovery playlist</p><p className="mt-1 text-sm font-semibold">{recovery?.automation?.filler.ready ? 'Local fallback active' : recovery?.connection === 'unavailable' ? 'Palazzo unavailable' : recovery?.preparedVersion ? 'Prepared for next session' : 'No prepared fallback'}</p></div><Link to="/radio-settings" className="text-xs font-semibold text-accent-blue hover:underline">Configure</Link></div>
              <p className="mt-1 text-xs text-text-secondary">Starting binds the prepared playlist to Palazzo. Stopping clears program audio and the binding.</p>
              <div className="mt-3 flex flex-wrap gap-2"><Button type="button" size="xs" variant="secondary" onClick={() => void commandRecovery('start')} disabled={recoveryBusy || !recovery?.preparedVersion || recovery.connection !== 'connected' || recovery.automation?.filler.ready}>Start with fallback</Button><Button type="button" size="xs" variant="destructive" onClick={() => void commandRecovery('stop')} disabled={recoveryBusy || !recovery?.automation?.filler.ready}>Stop session</Button></div>
              {recoveryError ? <p role="alert" className="mt-2 text-xs text-red-300">{recoveryError}</p> : null}
              </div>
            </details>
            <button type="button" onClick={() => setMixerOpen((open) => !open)} aria-expanded={mixerOpen} className="w-full rounded-lg border border-sand/30 px-3 py-2 text-left text-xs font-semibold text-text-secondary hover:bg-sand/10">{mixerOpen ? 'Hide' : 'Show'} mixer controls</button>
          {mixerOpen ? <Panel title="Radio Mixer" accent="#38bdf8" variant="monitor">
            <div className="grid gap-3 md:grid-cols-3">
              <RadioMixerChannel
                label="Song"
                channel={mixer.song}
                onVolumeChange={onSongVolumeChange}
                onToggleMuted={onToggleSongMuted}
              />
              <RadioMixerChannel
                label="Instants / bumpers"
                channel={mixer.instants}
                onVolumeChange={onInstantVolumeChange}
                onToggleMuted={onToggleInstantMuted}
              />
              <RadioMixerChannel
                label="Main output"
                channel={mixer.main}
                onVolumeChange={onMainVolumeChange}
              />
            </div>
            <div className="mt-2 min-h-4 text-[11px] font-mono">
              {mixer.error ? (
                <span className="text-red-400">{mixer.error}</span>
              ) : mixer.saving ? (
                <span className="text-emerald-400">APPLYING TO PALAZZO...</span>
              ) : null}
            </div>
          </Panel> : null}

          </div>
        </div>

        <div className="flex min-h-0 min-w-0 flex-col border-t border-sand/30 lg:border-l lg:border-t-0">
          <Panel
            title="Playlist"
            accent="#22c55e"
            variant="monitor"
            className="min-h-0"
            grow
            toolbar={
              <Button
                type="button"
                size="xs"
                variant="primary"
                onClick={() => setPlaylistSheetOpen(true)}
              >
                <Music2 className="h-3 w-3" />
                Add Songs
              </Button>
            }
          >
            <div className="flex min-h-0 flex-1 flex-col">
              <PlayNextQueue
                queue={songQueue}
                sequence={songSequence}
                activeQueueEntryId={programSongPlayback?.queueEntryId}
                onRemove={onRemoveQueuedSong}
                onReorder={onReorderSongQueue}
              />
              {queueError ? (
                <p
                  role="alert"
                  className="border-b border-red-400/20 px-3 py-2 text-[11px] text-red-300"
                >
                  {queueError}
                </p>
              ) : null}
              <div className="min-h-0 flex-1">
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
          </Panel>
          <Panel
            title="Sounders"
            accent="#f59e0b"
            variant="monitor"
            className="min-h-0"
            grow
            toolbar={
              <Button
                type="button"
                size="xs"
                variant="destructive"
                onClick={onStopAllInstants}
              >
                Stop All
              </Button>
            }
          >
            <InstantsPanel
              isLoading={false}
              instants={instants}
              search={instantSearch}
              playback={instantPlayback}
              onSearchChange={onInstantSearchChange}
              onTrigger={(id) => onTriggerInstant(id)}
            />
          </Panel>
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
        onTakeOffAir={async () => {
          await onTakeOffAir();
        }}
        onStopAllInstants={() => {
          onStopAllInstants();
        }}
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
    <section
      className="rounded-lg border border-sand/30 bg-dark-sand/70 p-3"
      aria-label={`${label} mixer channel`}
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-[10px] font-bold uppercase tracking-widest text-text-secondary">
          {label}
        </span>
        <div className="flex items-center gap-2">
          <span className="font-mono text-xs text-sky-300">{level}</span>
          {onToggleMuted ? (
            <Button
              type="button"
              size="xs"
              variant={channel.muted ? "destructive" : "secondary"}
              onClick={onToggleMuted}
              aria-pressed={channel.muted === true}
            >
              {channel.muted ? "MUTED" : "MUTE"}
            </Button>
          ) : null}
        </div>
      </div>
      <input
        type="range"
        min={0}
        max={1}
        step={0.01}
        value={channel.volume}
        onChange={(event) => onVolumeChange(Number(event.target.value))}
        aria-label={`${label} level`}
        className="w-full accent-sky-400"
      />
      <div
        className="mt-2 h-1.5 overflow-hidden rounded-full bg-black/40"
        aria-label={`${label} live peak`}
      >
        <div
          className={`h-full transition-[width] ${channel.muted ? "bg-red-700" : "bg-emerald-400"}`}
          style={{ width: peakPercent }}
        />
      </div>
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
