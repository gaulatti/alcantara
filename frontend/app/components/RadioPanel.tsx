import { useCallback, useEffect, useState } from "react";
import { Button, Panel } from "@gaulatti/bleecker";
import { apiUrl } from "../utils/apiBaseUrl";
import { Music2, Wifi, WifiOff, Radio } from "lucide-react";
import type {
  ProgramSongPlaybackState,
  SongCatalogItem,
  InstantItem,
} from "../models/broadcast";
import { PlaybackBar } from "./PlaybackBar";
import { InstantsPanel, PlaylistPanel, PlaylistSheetPanel } from "./panels";
import { faderToDb } from "../utils/audioTaper";

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
  programId: string;
  songSequence: any;
  songCatalog: SongCatalogItem[];
  programSongPlayback: ProgramSongPlaybackState | null;
  onSaveSongSequence: (seq: any) => Promise<void> | void;
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

export const RadioPanel: React.FC<RadioPanelProps> = ({
  programId,
  songSequence,
  songCatalog,
  programSongPlayback,
  onSaveSongSequence,
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
  const [stream, setStream] = useState<StreamStatus | null>(null);
  const [palazzo, setPalazzo] = useState<PalazzoStatus | null>(null);
  const [playlistSheetOpen, setPlaylistSheetOpen] = useState(false);

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

  useEffect(() => {
    fetchStreamStatus();
    fetchPalazzoStatus();
    const interval = setInterval(fetchStreamStatus, 8000);
    const palazzoInterval = setInterval(fetchPalazzoStatus, 8000);
    return () => {
      clearInterval(interval);
      clearInterval(palazzoInterval);
    };
  }, [fetchStreamStatus, fetchPalazzoStatus]);

  const handleTakeSelection = useCallback(
    async (seq: any) => {
      await onSaveSongSequence(seq);
      const item = seq?.items?.find((i: any) => i.id === seq?.activeItemId);
      if (!item?.audioUrl) return;
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
    [onSaveSongSequence, programId],
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

  return (
    <div className="flex min-h-0 w-full flex-1 flex-col overflow-hidden bg-dark-sand text-text-primary">
      <div className="grid min-h-0 flex-1 grid-cols-1 overflow-y-auto lg:grid-cols-[minmax(0,1fr)_24rem] lg:overflow-hidden">
        <div className="flex min-h-0 min-w-0 flex-col">
          <Panel title="Radio Mixer" accent="#38bdf8" variant="monitor">
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
          </Panel>
          <Panel
            title="Radio"
            accent={isLive ? "#22c55e" : "#ef4444"}
            variant="monitor"
            className="min-h-0"
            grow
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
                        ON AIR
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
        </div>

        <div className="flex min-h-0 min-w-0 flex-col border-t border-border-subtle lg:border-l lg:border-t-0">
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
            <PlaylistPanel
              sequence={songSequence}
              songCatalog={songCatalog}
              programSongPlayback={programSongPlayback}
              onChange={(seq) => {
                void onSaveSongSequence(seq);
              }}
              onTakeSelection={handleTakeSelection}
            />
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
