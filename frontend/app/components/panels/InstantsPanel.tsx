import { Button, Input } from '@gaulatti/bleecker';
import type { InstantItem, InstantPlaybackState } from '../../models/broadcast';
import { getInstantShortcutLetter, INSTANT_PLAYBACK_PULSE_ANIMATION, INSTANT_PLAYBACK_SWEEP_ANIMATION } from '../../utils/broadcast';

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
    <div className='p-3'>
      {isLoading ? (
        <p className='text-sm text-text-secondary dark:text-text-secondary'>Loading instants...</p>
      ) : instants.length === 0 ? (
        <p className='text-sm text-text-secondary dark:text-text-secondary'>No instants in catalog.</p>
      ) : (
        (() => {
          const filtered = instants.filter(
            (i) => !search.trim() || i.name.toLowerCase().includes(search.trim().toLowerCase())
          );
          return filtered.length === 0 ? (
            <p className='text-sm text-text-secondary dark:text-text-secondary'>
              No instants match &ldquo;{search}&rdquo;.
            </p>
          ) : (
            <div className='grid grid-cols-2 gap-1.5'>
              {filtered.map((instant) => {
                const originalIndex = instants.indexOf(instant);
                const playbackState = playback[instant.id] ?? null;
                const isPlaying = playbackState !== null;
                const shortcutLetter = getInstantShortcutLetter(originalIndex);

                return (
                  <Button
                    key={instant.id}
                    type='button'
                    onClick={() => onTrigger(instant.id)}
                    disabled={!instant.enabled}
                    title={`${instant.name}${shortcutLetter ? ` (Ctrl+${shortcutLetter})` : ''}`}
                    className={`relative overflow-hidden rounded border px-1.5 py-2 text-left text-[11px] font-medium leading-tight transition-colors ${
                      !instant.enabled
                        ? 'cursor-not-allowed border-sand/20 bg-sand/10 opacity-50 dark:border-sand/40'
                        : isPlaying
                          ? 'border-accent-blue/60 bg-accent-blue/15 text-text-primary ring-1 ring-accent-blue/30'
                          : 'border-sand/25 bg-dark-sand/80 text-text-primary hover:border-accent-blue/40 hover:bg-accent-blue/10 dark:border-sand/20 dark:bg-dark-sand/70 dark:text-text-primary dark:hover:border-accent-blue/40'
                    }`}
                  >
                    {shortcutLetter ? (
                      <span className='mb-0.5 block font-mono text-[9px] opacity-40'>{shortcutLetter}</span>
                    ) : null}
                    <span className='line-clamp-2'>{instant.name}</span>
                    {isPlaying ? (
                      <div className='pointer-events-none absolute inset-0 overflow-hidden rounded'>
                        {playbackState && playbackState.endsAtMs !== null ? (
                          <div
                            key={`${instant.id}-${playbackState.startedAtMs}`}
                            className='absolute inset-0 origin-left bg-accent-blue/20'
                            style={{
                              animation: `${INSTANT_PLAYBACK_SWEEP_ANIMATION} ${Math.max(200, playbackState.endsAtMs - playbackState.startedAtMs)}ms linear forwards`
                            }}
                          />
                        ) : (
                          <div
                            className='absolute inset-0 bg-accent-blue/15'
                            style={{
                              animation: `${INSTANT_PLAYBACK_PULSE_ANIMATION} 1400ms ease-in-out infinite`
                            }}
                          />
                        )}
                      </div>
                    ) : null}
                  </Button>
                );
              })}
            </div>
          );
        })()
      )}
    </div>
  );
}
