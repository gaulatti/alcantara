import { TooltipButton } from "./BleeckerButtons";
import { Button, Input } from "@gaulatti/bleecker";
import type { ComponentProps, ReactNode } from "react";
import type {
  MixerTakeChannelKey,
  MixerTakePresetSide,
  Scene,
} from "../models/broadcast";
import { dbToFader } from "../utils/audioTaper";
import {
  formatMixerLevelInputValue,
  formatTakePresetDbInputValue,
  parseMixerLevelInputToFader,
} from "../utils/broadcast";
import { ConfidenceMonitor } from "./BroadcastSwitcherDeck";
import { InstantsPanel, PlaylistPanel } from "./panels";

export interface TvAudioChannel {
  id: MixerTakeChannelKey;
  label: string;
  volume: number;
  muted?: boolean;
  solo?: boolean;
  meter?: { fill: number; peak: number; hold: number };
  presets?: { aDb: number; bDb: number };
  taking?: boolean;
  onVolumeChange: (value: number) => void;
  onToggleMuted?: () => void;
  onToggleSolo?: () => void;
  onCommitPreset?: (side: MixerTakePresetSide, raw: string) => number;
  onTake?: (side: MixerTakePresetSide) => void;
}

export interface TvAudioMixerProps {
  channels: TvAudioChannel[];
  fadeMs: number;
  onFadeChange: (value: number) => void;
  loading: boolean;
  saving: boolean;
  error: string | null;
}

function AudioChannel({
  channel,
  loading,
}: {
  channel: TvAudioChannel;
  loading: boolean;
}) {
  const level = formatMixerLevelInputValue(channel.volume);
  return (
    <section
      className="tv-audio-channel"
      data-channel={channel.id}
      aria-label={`${channel.label} mixer channel`}
    >
      <h3>{channel.label}</h3>
      <div className="tv-audio-channel-switches">
        {channel.onToggleMuted ? (
          <>
            <TooltipButton
              type="button"
              disabled={loading}
              title={`Mute or restore ${channel.label} in the Program mix`}
              aria-label={`Mute ${channel.label}`}
              aria-pressed={channel.muted}
              onClick={channel.onToggleMuted}
            >
              Mute
            </TooltipButton>
            <TooltipButton
              type="button"
              disabled={loading}
              title={`Listen to ${channel.label} alone in the Program mix`}
              aria-label={`Solo ${channel.label}`}
              aria-pressed={channel.solo}
              onClick={channel.onToggleSolo}
            >
              Solo
            </TooltipButton>
          </>
        ) : (
          <span className="console-eyebrow">Master</span>
        )}
      </div>
      <div className="tv-audio-fader-bank">
        <div className="tv-audio-fader-scale" aria-hidden="true">
          {[0, -8, -15, -28, -45].map((db) => (
            <span key={db} style={{ bottom: `${dbToFader(db) * 100}%` }}>
              {db}
            </span>
          ))}
          <span style={{ bottom: 0 }}>−∞</span>
        </div>
        <input
          type="range"
          min={0}
          max={1}
          step={0.005}
          value={channel.volume}
          disabled={loading}
          aria-label={`${channel.label} fader`}
          aria-orientation="vertical"
          aria-valuetext={`${level} dB`}
          onChange={(event) =>
            channel.onVolumeChange(Number(event.target.value))
          }
        />
        {channel.meter ? (
          <div
            className="tv-audio-meter"
            role="meter"
            aria-label={`${channel.label} live level`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={channel.meter.fill * 100}
          >
            <span
              className="tv-audio-meter-fill"
              style={{ height: `${channel.meter.fill * 100}%` }}
            />
            <span
              className="tv-audio-meter-peak"
              style={{ bottom: `${channel.meter.peak * 100}%` }}
            />
            <span
              className="tv-audio-meter-hold"
              style={{ bottom: `${channel.meter.hold * 100}%` }}
            />
          </div>
        ) : (
          <span
            className="tv-audio-meter-unavailable"
            title="No live meter supplied for this channel"
          >
            —
          </span>
        )}
      </div>
      <label className="tv-audio-level">
        <Input
          key={channel.volume}
          type="text"
          inputMode="decimal"
          disabled={loading}
          defaultValue={level}
          aria-label={`${channel.label} level in dB`}
          onBlur={(event) => {
            const next = parseMixerLevelInputToFader(
              event.target.value,
              channel.volume,
            );
            channel.onVolumeChange(next);
            event.target.value = formatMixerLevelInputValue(next);
          }}
        />
        <span>dB</span>
      </label>
      {channel.presets ? (
        <div className="tv-audio-presets">
          {(["a", "b"] as const).map((side) => {
            const db = channel.presets![side === "a" ? "aDb" : "bDb"];
            return (
              <label key={side}>
                <Input
                  key={db}
                  type="text"
                  inputMode="decimal"
                  disabled={loading}
                  defaultValue={formatTakePresetDbInputValue(db)}
                  aria-label={`${channel.label} preset ${side.toUpperCase()} in dB`}
                  onBlur={(event) => {
                    const next = channel.onCommitPreset!(
                      side,
                      event.target.value,
                    );
                    event.target.value = formatTakePresetDbInputValue(next);
                  }}
                />
                <TooltipButton
                  type="button"
                  disabled={loading || channel.taking}
                  title={`Fade ${channel.label} to saved level ${side.toUpperCase()} (${formatTakePresetDbInputValue(db)} dB)`}
                  aria-label={`Take ${channel.label} preset ${side.toUpperCase()}`}
                  onClick={() => channel.onTake!(side)}
                >
                  {channel.taking ? "…" : `TAKE ${side.toUpperCase()}`}
                </TooltipButton>
              </label>
            );
          })}
        </div>
      ) : (
        <p className="tv-audio-master-note">Program output</p>
      )}
    </section>
  );
}

export function TvAudioMixer({
  channels,
  fadeMs,
  onFadeChange,
  loading,
  saving,
  error,
}: TvAudioMixerProps) {
  return (
    <section className="console-panel tv-audio-mixer" aria-label="Audio mixer">
      <header className="console-panel-heading">
        <div>
          <h2>Mixer</h2>
        </div>
        <label className="tv-audio-fade">
          Preset fade{" "}
          <Input
            type="number"
            min={0}
            max={20000}
            step={100}
            value={fadeMs}
            aria-label="Preset fade in milliseconds"
            onChange={(event) => onFadeChange(Number(event.target.value))}
          />
          <span>ms</span>
        </label>
      </header>
      <div
        className="tv-audio-strips"
        style={{
          gridTemplateColumns: `repeat(${channels.length}, minmax(0, 1fr))`,
        }}
      >
        {channels.map((channel) => (
          <AudioChannel key={channel.id} channel={channel} loading={loading} />
        ))}
      </div>
      <footer className="tv-audio-mixer-status">
        {error ? (
          <p role="alert">{error}</p>
        ) : (
          <span role="status">
            {loading
              ? "Loading mixer…"
              : saving
                ? "Saving mix…"
                : "Levels in dB"}
          </span>
        )}
        <span>A / B · saved levels</span>
      </footer>
    </section>
  );
}

export function TvAudioWorkspace({
  programId,
  activeScene,
  mixer,
  music,
  cartwall,
  recording,
}: {
  programId: string;
  activeScene: Scene | null;
  mixer: TvAudioMixerProps;
  music: ComponentProps<typeof PlaylistPanel> & { onAddSongs: () => void };
  cartwall: ComponentProps<typeof InstantsPanel> & { onStopAll: () => void };
  recording: ReactNode;
}) {
  return (
    <div className="tv-audio-workspace" data-workspace-content="audio">
      <TvAudioMixer {...mixer} />
      <section
        className="console-panel tv-audio-music"
        aria-label="Music playlist"
      >
        <header className="console-panel-heading">
          <div>
            <h2>Playlist</h2>
          </div>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            title="Choose songs from the Media library for this playlist"
            onClick={music.onAddSongs}
          >
            Add songs
          </Button>
        </header>
        <div className="tv-audio-music-list">
          <PlaylistPanel {...music} />
        </div>
      </section>
      <aside className="tv-audio-utility">
        <div className="tv-audio-confidence">
          <ConfidenceMonitor
            label="PROGRAM"
            tone="program"
            scene={activeScene}
            src={`/program/${encodeURIComponent(programId)}?confidence=program`}
          />
          {recording}
        </div>
        <section
          className="console-panel tv-audio-cartwall"
          aria-label="Cartwall"
        >
          <header className="console-panel-heading">
            <div>
              <h2>Cartwall</h2>
            </div>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              title="Stop all playing Cartwall clips; music continues"
              onClick={cartwall.onStopAll}
            >
              Stop all
            </Button>
          </header>
          <div className="tv-audio-cartwall-list">
            <InstantsPanel {...cartwall} />
          </div>
        </section>
      </aside>
    </div>
  );
}
