import { useCallback, useEffect, useState } from "react";
import { Button, Panel, PanelColumn, PanelLayout } from "@gaulatti/bleecker";
import { apiUrl } from "../utils/apiBaseUrl";
import {
  Music2,
  Wifi,
  WifiOff,
  Settings,
  Save,
  ChevronDown,
  ChevronRight,
  Plus,
  Radio,
  Trash2,
} from "lucide-react";
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
  uptime: number;
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

interface RadioSettings {
  palazzoUrl: string;
  bumperEnabled: boolean;
  bumperInterval: number | null;
  bumperInstantIds: number[];
  bumperMode: string | null;
  enabled: boolean;
}

interface NowPlayingConsumer {
  id?: number;
  name: string;
  url: string;
  method: string;
  headers: NowPlayingHeader[];
  enabled: boolean;
}

interface NowPlayingHeader {
  id: string;
  name: string;
  value: string;
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
  const [radioSettings, setRadioSettings] = useState<RadioSettings | null>(
    null,
  );
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [savingSettings, setSavingSettings] = useState(false);
  const [settingsSaveError, setSettingsSaveError] = useState<string | null>(
    null,
  );
  const [nowPlayingConsumers, setNowPlayingConsumers] = useState<
    NowPlayingConsumer[]
  >([]);
  const [savingNowPlayingConsumers, setSavingNowPlayingConsumers] =
    useState(false);
  const [nowPlayingConsumerError, setNowPlayingConsumerError] = useState<
    string | null
  >(null);
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

  const fetchSettings = useCallback(async () => {
    try {
      const res = await fetch(
        apiUrl(`/radio/${encodeURIComponent(programId)}/settings`),
      );
      if (res.ok) {
        const data = await res.json();
        setRadioSettings(
          data || {
            palazzoUrl: "http://palazzo:3100",
            bumperEnabled: false,
            bumperInterval: null,
            bumperInstantIds: [],
            bumperMode: "sequential",
            enabled: false,
          },
        );
      }
    } catch {}
  }, [programId]);

  const fetchNowPlayingConsumers = useCallback(async () => {
    try {
      const res = await fetch(
        apiUrl(`/radio/${encodeURIComponent(programId)}/now-playing-consumers`),
      );
      if (!res.ok) return;
      const data = await res.json();
      setNowPlayingConsumers(
        Array.isArray(data) ? data.map(normalizeNowPlayingConsumer) : [],
      );
      setNowPlayingConsumerError(null);
    } catch {
      setNowPlayingConsumerError("Failed to load consumers");
    }
  }, [programId]);

  useEffect(() => {
    fetchStreamStatus();
    fetchSettings();
    fetchNowPlayingConsumers();
    fetchPalazzoStatus();
    const interval = setInterval(fetchStreamStatus, 8000);
    const palazzoInterval = setInterval(fetchPalazzoStatus, 8000);
    return () => {
      clearInterval(interval);
      clearInterval(palazzoInterval);
    };
  }, [
    fetchStreamStatus,
    fetchSettings,
    fetchNowPlayingConsumers,
    fetchPalazzoStatus,
  ]);

  const saveSettings = useCallback(async () => {
    if (!radioSettings) return;
    setSavingSettings(true);
    setSettingsSaveError(null);
    try {
      const res = await fetch(
        apiUrl(`/radio/${encodeURIComponent(programId)}/settings`),
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(radioSettings),
        },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setRadioSettings(await res.json());
    } catch {
      setSettingsSaveError("Radio settings were not saved.");
    } finally {
      setSavingSettings(false);
    }
  }, [programId, radioSettings]);

  const updateNowPlayingConsumer = useCallback(
    (index: number, patch: Partial<NowPlayingConsumer>) => {
      setNowPlayingConsumers((current) =>
        current.map((consumer, idx) =>
          idx === index ? { ...consumer, ...patch } : consumer,
        ),
      );
    },
    [],
  );

  const addNowPlayingConsumer = useCallback(() => {
    setNowPlayingConsumers((current) => [
      ...current,
      {
        name: `consumer-${current.length + 1}`,
        url: "",
        method: "POST",
        headers: [],
        enabled: true,
      },
    ]);
  }, []);

  const removeNowPlayingConsumer = useCallback((index: number) => {
    setNowPlayingConsumers((current) =>
      current.filter((_, idx) => idx !== index),
    );
  }, []);

  const addNowPlayingHeader = useCallback((consumerIndex: number) => {
    setNowPlayingConsumers((current) =>
      current.map((consumer, idx) =>
        idx === consumerIndex
          ? {
              ...consumer,
              headers: [...consumer.headers, createNowPlayingHeader()],
            }
          : consumer,
      ),
    );
  }, []);

  const updateNowPlayingHeader = useCallback(
    (
      consumerIndex: number,
      headerId: string,
      patch: Partial<NowPlayingHeader>,
    ) => {
      setNowPlayingConsumers((current) =>
        current.map((consumer, idx) =>
          idx === consumerIndex
            ? {
                ...consumer,
                headers: consumer.headers.map((header) =>
                  header.id === headerId ? { ...header, ...patch } : header,
                ),
              }
            : consumer,
        ),
      );
    },
    [],
  );

  const removeNowPlayingHeader = useCallback(
    (consumerIndex: number, headerId: string) => {
      setNowPlayingConsumers((current) =>
        current.map((consumer, idx) =>
          idx === consumerIndex
            ? {
                ...consumer,
                headers: consumer.headers.filter(
                  (header) => header.id !== headerId,
                ),
              }
            : consumer,
        ),
      );
    },
    [],
  );

  const saveNowPlayingConsumers = useCallback(async () => {
    setSavingNowPlayingConsumers(true);
    setNowPlayingConsumerError(null);
    try {
      const consumers = nowPlayingConsumers.map((consumer, index) => {
        const headers = Object.fromEntries(
          consumer.headers
            .filter((header) => header.name.trim() && header.value.trim())
            .map((header) => [header.name.trim(), header.value.trim()]),
        );
        if (
          consumer.headers.some(
            (header) => !header.name.trim() && header.value.trim(),
          )
        ) {
          throw new Error(`Consumer ${index + 1}: header name is required`);
        }
        return {
          name: consumer.name,
          url: consumer.url,
          method: consumer.method,
          headers,
          enabled: consumer.enabled,
        };
      });

      const res = await fetch(
        apiUrl(`/radio/${encodeURIComponent(programId)}/now-playing-consumers`),
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ consumers }),
        },
      );
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const data = await res.json();
      setNowPlayingConsumers(
        Array.isArray(data) ? data.map(normalizeNowPlayingConsumer) : [],
      );
    } catch (err) {
      setNowPlayingConsumerError(
        err instanceof Error ? err.message : String(err),
      );
    } finally {
      setSavingNowPlayingConsumers(false);
    }
  }, [nowPlayingConsumers, programId]);

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
    <div className="flex h-full w-full flex-1 min-h-0 flex-col overflow-hidden bg-dark-sand text-text-primary">
      <PanelLayout className="w-full h-full min-h-0" padding="p-0">
        <PanelColumn className="min-w-0" grow>
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
                    className="flex items-center gap-2"
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

              <div className="rounded-xl border border-sand/30 bg-dark-sand/70 overflow-hidden">
                <button
                  type="button"
                  onClick={() => setSettingsOpen(!settingsOpen)}
                  className="flex items-center justify-between w-full p-3 text-left hover:bg-dark-sand/80 transition-colors"
                >
                  <div className="flex items-center gap-2">
                    <Settings className="h-4 w-4 text-text-secondary" />
                    <span className="text-xs font-bold text-text-secondary uppercase tracking-wider">
                      Settings
                    </span>
                    {radioSettings?.enabled && (
                      <span className="text-[10px] font-mono text-green-400 bg-green-400/10 px-1.5 py-0.5 rounded">
                        ENABLED
                      </span>
                    )}
                    {!radioSettings?.enabled && radioSettings && (
                      <span className="text-[10px] font-mono text-text-secondary bg-sand/20 px-1.5 py-0.5 rounded">
                        DISABLED
                      </span>
                    )}
                  </div>
                  {settingsOpen ? (
                    <ChevronDown className="h-4 w-4 text-text-secondary" />
                  ) : (
                    <ChevronRight className="h-4 w-4 text-text-secondary" />
                  )}
                </button>
                {settingsOpen && radioSettings && (
                  <div className="border-t border-sand/30 p-3 space-y-3">
                    <SettingsField
                      label="Palazzo URL"
                      value={radioSettings.palazzoUrl}
                      onChange={(v) =>
                        setRadioSettings({ ...radioSettings, palazzoUrl: v })
                      }
                    />
                    <div className="pt-2 space-y-2 border-t border-sand/30">
                      <div className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          checked={radioSettings.bumperEnabled}
                          onChange={(e) =>
                            setRadioSettings({
                              ...radioSettings,
                              bumperEnabled: e.target.checked,
                            })
                          }
                          className="rounded accent-violet-500"
                        />
                        <span className="text-[10px] font-bold text-text-secondary uppercase">
                          Bumper/ID
                        </span>
                        {radioSettings.bumperEnabled && (
                          <select
                            value={radioSettings.bumperMode || "sequential"}
                            onChange={(e) =>
                              setRadioSettings({
                                ...radioSettings,
                                bumperMode: e.target.value,
                              })
                            }
                            className="rounded bg-dark-sand/60 border border-sand/30 px-2 py-0.5 text-[10px] text-text-primary font-mono focus:outline-none focus:border-violet-500"
                          >
                            <option value="sequential">Sequential</option>
                            <option value="random">Random</option>
                          </select>
                        )}
                      </div>
                      {radioSettings.bumperEnabled && (
                        <>
                          <SettingsField
                            label="Every N songs"
                            value={
                              radioSettings.bumperInterval != null
                                ? String(radioSettings.bumperInterval)
                                : "4"
                            }
                            onChange={(v) =>
                              setRadioSettings({
                                ...radioSettings,
                                bumperInterval: v ? Number(v) : null,
                              })
                            }
                          />
                          <label className="space-y-1">
                            <span className="text-[10px] font-bold text-text-secondary uppercase">
                              Instants
                            </span>
                            <div className="flex flex-wrap gap-1">
                              {instants.map((inst) => {
                                const selected =
                                  radioSettings.bumperInstantIds.includes(
                                    inst.id,
                                  );
                                return (
                                  <button
                                    key={inst.id}
                                    type="button"
                                    onClick={() => {
                                      const next = selected
                                        ? radioSettings.bumperInstantIds.filter(
                                            (id) => id !== inst.id,
                                          )
                                        : [
                                            ...radioSettings.bumperInstantIds,
                                            inst.id,
                                          ];
                                      setRadioSettings({
                                        ...radioSettings,
                                        bumperInstantIds: next,
                                      });
                                    }}
                                    className={`rounded px-2 py-0.5 text-[10px] font-medium transition-colors ${selected ? "bg-violet-600 text-white" : "bg-dark-sand/60 border border-sand/30 text-text-secondary hover:text-text-primary"}`}
                                  >
                                    {inst.name}
                                  </button>
                                );
                              })}
                            </div>
                          </label>
                        </>
                      )}
                    </div>
                    <div className="flex items-center justify-between pt-2 border-t border-sand/30">
                      <label className="flex items-center gap-2 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={radioSettings.enabled}
                          onChange={(e) =>
                            setRadioSettings({
                              ...radioSettings,
                              enabled: e.target.checked,
                            })
                          }
                          className="rounded accent-violet-500"
                        />
                        <span className="text-xs font-bold text-text-secondary">
                          Enabled
                        </span>
                      </label>
                      <Button
                        type="button"
                        onClick={saveSettings}
                        disabled={savingSettings}
                        className="flex items-center gap-1 rounded-lg bg-violet-600 px-3 py-1.5 text-xs font-bold text-white hover:bg-violet-500 transition-colors disabled:opacity-50"
                      >
                        <Save className="h-3 w-3" />
                        {savingSettings ? "SAVING..." : "SAVE"}
                      </Button>
                    </div>
                    {settingsSaveError ? (
                      <p className="text-[11px] text-red-400">
                        {settingsSaveError}
                      </p>
                    ) : null}
                    <div className="pt-3 space-y-3 border-t border-sand/30">
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-[10px] font-bold text-text-secondary uppercase">
                          Now Playing Consumers
                        </span>
                        <Button
                          type="button"
                          onClick={addNowPlayingConsumer}
                          className="flex items-center gap-1 rounded bg-dark-sand/60 border border-sand/30 px-2 py-1 text-[10px] font-bold text-text-primary hover:border-violet-500 transition-colors"
                        >
                          <Plus className="h-3 w-3" />
                          Add
                        </Button>
                      </div>
                      {nowPlayingConsumers.length === 0 ? (
                        <div className="rounded border border-dashed border-sand/30 p-3 text-center text-xs text-text-secondary">
                          No consumers configured.
                        </div>
                      ) : (
                        <div className="space-y-2">
                          {nowPlayingConsumers.map((consumer, index) => (
                            <div
                              key={consumer.id ?? index}
                              className="rounded-lg border border-sand/30 bg-dark-sand/50 p-3 space-y-2"
                            >
                              <div className="flex items-center justify-between gap-2">
                                <label className="flex items-center gap-2 cursor-pointer">
                                  <input
                                    type="checkbox"
                                    checked={consumer.enabled}
                                    onChange={(e) =>
                                      updateNowPlayingConsumer(index, {
                                        enabled: e.target.checked,
                                      })
                                    }
                                    className="rounded accent-violet-500"
                                  />
                                  <span className="text-[10px] font-bold text-text-secondary uppercase">
                                    Enabled
                                  </span>
                                </label>
                                <button
                                  type="button"
                                  onClick={() =>
                                    removeNowPlayingConsumer(index)
                                  }
                                  className="rounded p-1 text-red-400 hover:bg-red-500/10 hover:text-red-300"
                                  title="Remove consumer"
                                  aria-label="Remove consumer"
                                >
                                  <Trash2 className="h-3.5 w-3.5" />
                                </button>
                              </div>
                              <div className="grid grid-cols-[1fr_88px] gap-2">
                                <SettingsField
                                  label="Name"
                                  value={consumer.name}
                                  onChange={(v) =>
                                    updateNowPlayingConsumer(index, { name: v })
                                  }
                                />
                                <label className="space-y-1">
                                  <span className="text-[10px] font-bold text-text-secondary uppercase">
                                    Method
                                  </span>
                                  <select
                                    value={consumer.method}
                                    onChange={(e) =>
                                      updateNowPlayingConsumer(index, {
                                        method: e.target.value,
                                      })
                                    }
                                    className="w-full rounded bg-dark-sand/60 border border-sand/30 px-2 py-1 text-xs text-text-primary font-mono focus:outline-none focus:border-violet-500"
                                  >
                                    <option value="POST">POST</option>
                                    <option value="PUT">PUT</option>
                                    <option value="PATCH">PATCH</option>
                                  </select>
                                </label>
                              </div>
                              <SettingsField
                                label="URL"
                                value={consumer.url}
                                onChange={(v) =>
                                  updateNowPlayingConsumer(index, { url: v })
                                }
                              />
                              <div className="space-y-2">
                                <div className="flex items-center justify-between gap-2">
                                  <span className="text-[10px] font-bold text-text-secondary uppercase">
                                    Headers
                                  </span>
                                  <button
                                    type="button"
                                    onClick={() => addNowPlayingHeader(index)}
                                    className="flex items-center gap-1 rounded border border-sand/30 bg-dark-sand/60 px-2 py-1 text-[10px] font-bold text-text-primary hover:border-violet-500"
                                    title="Add header"
                                  >
                                    <Plus className="h-3 w-3" />
                                    Header
                                  </button>
                                </div>
                                {consumer.headers.length === 0 ? (
                                  <div className="rounded border border-dashed border-sand/30 px-2 py-2 text-[11px] text-text-secondary">
                                    No headers.
                                  </div>
                                ) : (
                                  <div className="space-y-1.5">
                                    {consumer.headers.map((header) => (
                                      <div
                                        key={header.id}
                                        className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_28px] gap-1.5"
                                      >
                                        <input
                                          value={header.name}
                                          onChange={(e) =>
                                            updateNowPlayingHeader(
                                              index,
                                              header.id,
                                              { name: e.target.value },
                                            )
                                          }
                                          className="min-w-0 rounded bg-dark-sand/60 border border-sand/30 px-2 py-1 text-xs text-text-primary font-mono focus:outline-none focus:border-violet-500"
                                          aria-label="Header name"
                                        />
                                        <input
                                          value={header.value}
                                          onChange={(e) =>
                                            updateNowPlayingHeader(
                                              index,
                                              header.id,
                                              { value: e.target.value },
                                            )
                                          }
                                          className="min-w-0 rounded bg-dark-sand/60 border border-sand/30 px-2 py-1 text-xs text-text-primary font-mono focus:outline-none focus:border-violet-500"
                                          aria-label="Header value"
                                        />
                                        <button
                                          type="button"
                                          onClick={() =>
                                            removeNowPlayingHeader(
                                              index,
                                              header.id,
                                            )
                                          }
                                          className="flex h-7 w-7 items-center justify-center rounded text-red-400 hover:bg-red-500/10 hover:text-red-300"
                                          title="Remove header"
                                          aria-label="Remove header"
                                        >
                                          <Trash2 className="h-3.5 w-3.5" />
                                        </button>
                                      </div>
                                    ))}
                                  </div>
                                )}
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                      {nowPlayingConsumerError && (
                        <p className="text-[11px] text-red-400">
                          {nowPlayingConsumerError}
                        </p>
                      )}
                      <div className="flex justify-end">
                        <Button
                          type="button"
                          onClick={saveNowPlayingConsumers}
                          disabled={savingNowPlayingConsumers}
                          className="flex items-center gap-1 rounded-lg bg-violet-600 px-3 py-1.5 text-xs font-bold text-white hover:bg-violet-500 transition-colors disabled:opacity-50"
                        >
                          <Save className="h-3 w-3" />
                          {savingNowPlayingConsumers
                            ? "SAVING..."
                            : "SAVE CONSUMERS"}
                        </Button>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </Panel>
        </PanelColumn>

        <PanelColumn className="shrink-0 w-[380px]">
          <Panel
            title="Playlist"
            accent="#22c55e"
            variant="monitor"
            className="min-h-0"
            grow
            toolbar={
              <Button
                type="button"
                onClick={() => setPlaylistSheetOpen(true)}
                className="flex items-center gap-1 rounded bg-violet-600 px-2 py-1 text-[10px] font-bold text-white hover:bg-violet-500"
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
                onClick={onStopAllInstants}
                className="text-[10px] font-bold text-red-400 hover:text-red-300 px-1"
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
        </PanelColumn>
      </PanelLayout>

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
              onClick={onToggleMuted}
              aria-pressed={channel.muted === true}
              className={`rounded px-2 py-1 text-[10px] font-bold ${channel.muted ? "bg-red-600 text-white" : "border border-sand/30 bg-dark-sand text-text-secondary"}`}
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

function normalizeNowPlayingConsumer(value: any): NowPlayingConsumer {
  const headers =
    value?.headers &&
    typeof value.headers === "object" &&
    !Array.isArray(value.headers)
      ? (value.headers as Record<string, string>)
      : {};
  return {
    id: typeof value?.id === "number" ? value.id : undefined,
    name: typeof value?.name === "string" ? value.name : "",
    url: typeof value?.url === "string" ? value.url : "",
    method: typeof value?.method === "string" ? value.method : "POST",
    headers: Object.entries(headers).map(([name, headerValue], index) => ({
      id: `${Date.now().toString(36)}-${index}`,
      name,
      value: String(headerValue),
    })),
    enabled: value?.enabled !== false,
  };
}

function createNowPlayingHeader(): NowPlayingHeader {
  return {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
    name: "",
    value: "",
  };
}

function SettingsField({
  label,
  value,
  onChange,
  placeholder,
  password,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  password?: boolean;
}) {
  return (
    <label className="space-y-1">
      <span className="text-[10px] font-bold text-text-secondary uppercase">
        {label}
      </span>
      <input
        type={password ? "password" : "text"}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded bg-dark-sand/60 border border-sand/30 px-2 py-1 text-xs text-text-primary font-mono focus:outline-none focus:border-violet-500"
      />
    </label>
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
