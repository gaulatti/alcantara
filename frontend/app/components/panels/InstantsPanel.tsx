import { Input } from "@gaulatti/bleecker";
import { Play } from "lucide-react";
import type { InstantItem, InstantPlaybackState } from "../../models/broadcast";
import {
  getInstantShortcutLetter,
  INSTANT_PLAYBACK_PULSE_ANIMATION,
  INSTANT_PLAYBACK_SWEEP_ANIMATION,
} from "../../utils/broadcast";

interface InstantsPanelProps {
  isLoading: boolean;
  instants: InstantItem[];
  search: string;
  playback: Record<number, InstantPlaybackState>;
  onSearchChange: (value: string) => void;
  onTrigger: (id: number) => void;
}

export function InstantsPanel({
  isLoading,
  instants,
  search,
  playback,
  onSearchChange,
  onTrigger,
}: InstantsPanelProps) {
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
                const shortcutLetter = getInstantShortcutLetter(originalIndex);

                return (
                  <button
                    key={instant.id}
                    type="button"
                    onClick={() => onTrigger(instant.id)}
                    disabled={!instant.enabled}
                    title={`${instant.name}${shortcutLetter ? ` (Ctrl+${shortcutLetter})` : ""}`}
                    className="console-cart"
                    data-playing={isPlaying}
                    aria-label={`${instant.name}${isPlaying ? " · playing" : ""}`}
                  >
                    <span className="console-cart-top">
                      <span>{String(originalIndex + 1).padStart(2, "0")}</span>
                      {shortcutLetter ? (
                        <kbd>Ctrl+{shortcutLetter}</kbd>
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
                  </button>
                );
              })}
            </div>
          );
        })()
      )}
    </div>
  );
}
