import { TooltipButton } from "../BleeckerButtons";
import { Input } from "@gaulatti/bleecker";
import { useEffect, useState } from "react";
import { Headphones, Play } from "lucide-react";
import type { InstantItem, InstantPlaybackState } from "../../models/broadcast";
import { cartChordLabel, platformIsMac } from "../../utils/cartModifier";
import {
  getInstantShortcutLetter,
  INSTANT_PLAYBACK_PULSE_ANIMATION,
  INSTANT_PLAYBACK_SWEEP_ANIMATION,
} from "../../utils/broadcast";

/** Seconds left as m:ss, never below zero. */
function formatSecondsLeft(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

interface InstantsPanelProps {
  isLoading: boolean;
  instants: InstantItem[];
  search: string;
  playback: Record<number, InstantPlaybackState>;
  onSearchChange: (value: string) => void;
  onTrigger: (id: number) => void;
  /** Pre-fade listen per pad (the radio desk): plays here only, never triggers the pad (#835). */
  preListen?: { activeId: number | null; onToggle: (instant: InstantItem) => void };
  /** When given, no pad can be triggered and each says why; pre-listen stays. */
  disabledHelp?: string;
}

export function InstantsPanel({
  isLoading,
  instants,
  search,
  playback,
  onSearchChange,
  onTrigger,
  preListen,
  disabledHelp,
}: InstantsPanelProps) {
  // The time left of a playing sounder, redrawn each second while any plays (#298).
  const anyPlaying = Object.keys(playback).length > 0;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!anyPlaying) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [anyPlaying]);
  return (
    <div>
      <div className="console-cart-search">
        <Input
          aria-label="Search cartwall"
          placeholder="Find a sounder…"
          value={search}
          onChange={(event) => onSearchChange(event.target.value)}
        />
      </div>
      {isLoading ? (
        <p className="text-sm text-text-secondary dark:text-text-secondary">
          Loading instants...
        </p>
      ) : instants.length === 0 ? (
        <p className="text-sm text-text-secondary dark:text-text-secondary">
          No instants in catalog.
        </p>
      ) : (
        (() => {
          const isMac = platformIsMac();
          const filtered = instants.filter(
            (i) =>
              !search.trim() ||
              i.name.toLowerCase().includes(search.trim().toLowerCase()),
          );
          return filtered.length === 0 ? (
            <p className="text-sm text-text-secondary dark:text-text-secondary">
              No instants match &ldquo;{search}&rdquo;.
            </p>
          ) : (
            <div className="console-cart-grid">
              {filtered.map((instant) => {
                const originalIndex = instants.indexOf(instant);
                const playbackState = playback[instant.id] ?? null;
                const isPlaying = playbackState !== null;
                const shortcutLetter = getInstantShortcutLetter(originalIndex, isMac);

                const pad = (
                  <TooltipButton
                    key={instant.id}
                    type="button"
                    onClick={() => onTrigger(instant.id)}
                    disabled={disabledHelp !== undefined || !instant.enabled}
                    title={disabledHelp ?? `${instant.name}${shortcutLetter ? ` (${cartChordLabel(shortcutLetter, isMac)})` : ""}`}
                    className="console-cart"
                    data-playing={isPlaying}
                    aria-label={`${instant.name}${isPlaying ? " · playing" : ""}`}
                  >
                    <span className="console-cart-top">
                      <span>{String(originalIndex + 1).padStart(2, "0")}</span>
                      {shortcutLetter ? (
                        <kbd>{cartChordLabel(shortcutLetter, isMac)}</kbd>
                      ) : (
                        <Play size={10} />
                      )}
                    </span>
                    <span className="console-cart-name line-clamp-2 relative z-10">
                      {instant.name}
                    </span>
                    {isPlaying && (
                      <span className="console-cart-playing">PLAYING</span>
                    )}
                    {playbackState && playbackState.endsAtMs !== null ? (
                      <span
                        data-testid="cart-time-left"
                        className="console-cart-left relative z-10 text-[10px] tabular-nums"
                      >
                        {formatSecondsLeft(playbackState.endsAtMs - now)} left
                      </span>
                    ) : null}
                    {isPlaying ? (
                      <div className="pointer-events-none absolute inset-0 overflow-hidden rounded">
                        {playbackState && playbackState.endsAtMs !== null ? (
                          <div
                            key={`${instant.id}-${playbackState.startedAtMs}`}
                            className="absolute inset-0 origin-left bg-accent-blue/20"
                            style={{
                              animation: `${INSTANT_PLAYBACK_SWEEP_ANIMATION} ${Math.max(200, playbackState.endsAtMs - playbackState.startedAtMs)}ms linear forwards`,
                            }}
                          />
                        ) : (
                          <div
                            className="absolute inset-0 bg-accent-blue/15"
                            style={{
                              animation: `${INSTANT_PLAYBACK_PULSE_ANIMATION} 1400ms ease-in-out infinite`,
                            }}
                          />
                        )}
                      </div>
                    ) : null}
                  </TooltipButton>
                );
                if (!preListen) return pad;
                // Beside the pad, not inside it: a button cannot hold another, and pressing it must not fire the pad.
                return (
                  <div key={instant.id} className="console-cart-slot">
                    {pad}
                    <button
                      type="button"
                      className="console-cart-pfl"
                      aria-label={`Pre-listen ${instant.name}`}
                      title="Pre-listen on this device only; not on air"
                      aria-pressed={preListen.activeId === instant.id}
                      onClick={() => preListen.onToggle(instant)}
                    >
                      <Headphones size={13} />
                    </button>
                  </div>
                );
              })}
            </div>
          );
        })()
      )}
    </div>
  );
}
