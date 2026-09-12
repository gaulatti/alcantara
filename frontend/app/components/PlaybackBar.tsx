import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, IconButton } from '@gaulatti/bleecker';
import { Music2, Play, Repeat2, Shuffle, SkipBack, SkipForward, Square, ZapOff } from 'lucide-react';
import {
  createProgramSongSequence,
  getProgramSongSequenceSelectedItemId,
  normalizeProgramSongSequence,
  shuffleProgramSongSequence,
  type ProgramSongSequence,
} from '../utils/programSequence';
import type { ProgramSongPlaybackState } from '../models/broadcast';

function flattenProgramSongItems(items: ProgramSongSequence['items']): Extract<ProgramSongSequence['items'][number], { kind: 'preset' }>[] {
  const flat: Extract<ProgramSongSequence['items'][number], { kind: 'preset' }>[] = [];
  for (const item of items) {
    if (item.kind === 'preset') {
      flat.push(item);
      continue;
    }
    flat.push(...flattenProgramSongItems(item.sequence.items));
  }
  return flat;
}

function normalizeProgramSongPlaylist(sequence: ProgramSongSequence): ProgramSongSequence {
  const playlistItems = flattenProgramSongItems(sequence.items);
  return {
    ...sequence,
    items: playlistItems,
    activeItemId:
      sequence.activeItemId === null
        ? null
        : sequence.activeItemId && playlistItems.some((i) => i.id === sequence.activeItemId)
          ? sequence.activeItemId
          : (playlistItems[0]?.id ?? null)
  };
}

interface SceneQuickAction {
  id: number;
  name: string;
  isActive: boolean;
  isStaged: boolean;
  shortcutLabel: string;
}

interface PlaybackBarProps {
  sequence: ProgramSongSequence;
  programSongPlayback: ProgramSongPlaybackState | null;
  sceneQuickActions?: SceneQuickAction[];
  onChange: (nextSequence: ProgramSongSequence) => void;
  onTakeSelection?: (nextSequence: ProgramSongSequence) => Promise<void> | void;
  onTakeOffAir?: () => Promise<void> | void;
  onStopAllInstants?: () => void;
  onStageScene?: (sceneId: number) => void;
  onTakeScene?: (sceneId: number) => void;
}

export function PlaybackBar({
  sequence: _sequence,
  programSongPlayback = null,
  sceneQuickActions = [],
  onChange,
  onTakeSelection,
  onTakeOffAir,
  onStopAllInstants,
  onStageScene,
}: PlaybackBarProps) {
  const sequence = useMemo(() => {
    const n = normalizeProgramSongSequence(_sequence);
    return n ? normalizeProgramSongPlaylist(n) : { ...createProgramSongSequence('manual'), activeItemId: null };
  }, [_sequence]);

  const [nowMs, setNowMs] = useState(() => Date.now());
  const [stickyPlaybackItemId, setStickyPlaybackItemId] = useState<string | null>(null);
  const sequenceRef = useRef(sequence);
  const effectiveActiveItemId = getProgramSongSequenceSelectedItemId(sequence, nowMs);
  const automaticPlayback = sequence.mode === 'autoplay' || sequence.mode === 'shuffle';

  const showSceneQuickBar = sceneQuickActions.length > 0;

  const applySequence = useCallback(
    (nextSequence: ProgramSongSequence) => {
      onChange(nextSequence);
    },
    [onChange]
  );

  const playbackActiveItemId = useMemo(() => {
    if (!programSongPlayback?.isPlaying) return null;
    const token = (programSongPlayback.token || '').trim();
    const url = (programSongPlayback.audioUrl || '').trim();
    if (token) {
      const m = sequence.items.find((i) => i.id && token.startsWith(`${i.id}:`));
      if (m) return m.id;
    }
    if (url) {
      const matches = sequence.items.filter((i) => i.kind === 'preset' && (i.audioUrl || '').trim() === url);
      if (matches.length === 1) return matches[0]?.id ?? null;
      if (matches.length > 1) {
        if (sequence.activeItemId && matches.some((i) => i.id === sequence.activeItemId)) return sequence.activeItemId;
        if (effectiveActiveItemId && matches.some((i) => i.id === effectiveActiveItemId)) return effectiveActiveItemId;
      }
    }
    return null;
  }, [effectiveActiveItemId, programSongPlayback, sequence]);

  useEffect(() => {
    if (programSongPlayback?.isPlaying) {
      if (playbackActiveItemId && sequence.items.some((i) => i.id === playbackActiveItemId)) {
        if (stickyPlaybackItemId !== playbackActiveItemId) setStickyPlaybackItemId(playbackActiveItemId);
        return;
      }
      if (stickyPlaybackItemId && !sequence.items.some((i) => i.id === stickyPlaybackItemId)) setStickyPlaybackItemId(null);
      return;
    }
    if (stickyPlaybackItemId !== null) setStickyPlaybackItemId(null);
  }, [playbackActiveItemId, programSongPlayback?.isPlaying, sequence.items, stickyPlaybackItemId]);

  const runtimeActiveItemId = useMemo(() => {
    if (programSongPlayback?.isPlaying) {
      return stickyPlaybackItemId ?? playbackActiveItemId ?? sequence.activeItemId ?? (automaticPlayback ? effectiveActiveItemId : null) ?? null;
    }
    return sequence.activeItemId ?? (automaticPlayback ? effectiveActiveItemId : null) ?? null;
  }, [automaticPlayback, effectiveActiveItemId, playbackActiveItemId, programSongPlayback?.isPlaying, sequence.activeItemId, stickyPlaybackItemId]);

  const runtimeActiveItemIndex = runtimeActiveItemId ? sequence.items.findIndex((i) => i.id === runtimeActiveItemId) : -1;

  useEffect(() => {
    sequenceRef.current = sequence;
  }, [sequence]);

  useEffect(() => {
    if (!programSongPlayback?.isPlaying) return;
    const timer = setInterval(() => setNowMs(Date.now()), 250);
    return () => clearInterval(timer);
  }, [programSongPlayback?.isPlaying]);

  const clearActiveItem = useCallback(async () => {
    const next = { ...sequence, mode: 'manual' as const, activeItemId: null };
    if (onTakeOffAir) {
      await onTakeOffAir();
      return;
    }
    if (onTakeSelection) await onTakeSelection(next);
    else applySequence(next);
  }, [applySequence, onTakeOffAir, onTakeSelection, sequence]);

  const activateItem = useCallback(
    async (itemId: string) => {
      const next = { ...sequence, activeItemId: itemId, startedAt: Date.now() };
      if (onTakeSelection) await onTakeSelection(next);
      else applySequence(next);
    },
    [applySequence, onTakeSelection, sequence]
  );

  return (
    <div className='bg-dark-sand/95 shadow-[0_-10px_28px_rgba(0,0,0,0.45)] backdrop-blur supports-[backdrop-filter]:bg-dark-sand/90'>
      {showSceneQuickBar ? (
        <div className='border-t border-sand/30 bg-dark-sand/90 px-4 py-2'>
          <div className='flex items-center gap-2 overflow-x-auto'>
            {sceneQuickActions.map((a) => (
              <Button
                key={a.id}
                onClick={() => onStageScene?.(a.id)}
                title={`${a.name} (click to stage in Preview)`}
                variant='ghost'
                size='sm'
                className={`relative min-w-[150px] max-w-[240px] shrink-0 overflow-hidden rounded border px-2 py-1.5 text-left text-[11px] font-medium leading-tight transition-colors ${a.isActive ? 'border-terracotta/80 bg-terracotta/35 text-white ring-1 ring-terracotta/50' : a.isStaged ? 'border-accent-blue/80 bg-accent-blue/35 text-white ring-1 ring-accent-blue/50' : 'border-sand/25 bg-dark-sand/80 text-text-primary hover:border-sea/40 hover:bg-sea/10'}`}
              >
                <span className='mb-0.5 block font-mono text-[9px] opacity-50'>{a.shortcutLabel}</span>
                <span className='line-clamp-2'>{a.name}</span>
              </Button>
            ))}
          </div>
        </div>
      ) : null}
      <div className='flex flex-wrap items-center justify-between gap-2 border-t border-sand/30 bg-dark-sand/85 px-3 py-2 sm:px-4 sm:py-3 md:flex-nowrap'>
        <div className='order-2 flex items-center gap-2 md:order-none'>
          <IconButton
            type='button'
            title='Previous'
            disabled={runtimeActiveItemIndex <= 0}
            onClick={() => {
              if (runtimeActiveItemIndex > 0) void activateItem(sequence.items[runtimeActiveItemIndex - 1].id);
            }}
            className='flex h-8 w-8 items-center justify-center rounded-full border-0 bg-transparent p-0 text-text-secondary shadow-none transition-colors hover:translate-y-0 hover:scale-100 hover:text-text-primary disabled:opacity-30'
            aria-label='Previous'
          >
            <SkipBack size={16} fill='currentColor' />
          </IconButton>
          <IconButton
            type='button'
            title={programSongPlayback?.isPlaying ? 'Advance' : 'Play selection'}
            disabled={
              sequence.items.length === 0 ||
              (programSongPlayback?.isPlaying === true &&
                runtimeActiveItemIndex === sequence.items.length - 1 &&
                sequence.loop === false)
            }
            onClick={() => {
              if (!programSongPlayback?.isPlaying) {
                const selection = runtimeActiveItemId ?? sequence.items[0]?.id ?? null;
                if (selection) void activateItem(selection);
              } else if (runtimeActiveItemId) {
                const idx = sequence.items.findIndex((i) => i.id === runtimeActiveItemId);
                if (idx < sequence.items.length - 1) void activateItem(sequence.items[idx + 1].id);
                else if (sequence.loop !== false) void activateItem(sequence.items[0].id);
              }
            }}
            className='flex h-10 w-10 items-center justify-center rounded-full border-0 bg-sea p-0 text-white shadow-lg transition-transform hover:translate-y-0 hover:scale-105 hover:bg-accent-blue active:scale-95'
            aria-label={programSongPlayback?.isPlaying ? 'Advance' : 'Play selection'}
          >
            <Play size={18} fill='currentColor' className='ml-0.5' />
          </IconButton>
          <IconButton
            type='button'
            title='Stop / Take Off Air'
            onClick={() => void clearActiveItem()}
            className='flex h-8 w-8 items-center justify-center rounded-full border-0 bg-transparent p-0 text-text-secondary shadow-none transition-colors hover:translate-y-0 hover:scale-100 hover:text-text-primary'
            aria-label='Stop / Take Off Air'
          >
            <Square size={16} fill='currentColor' />
          </IconButton>
          <IconButton
            type='button'
            title='Next'
            disabled={runtimeActiveItemIndex < 0 || runtimeActiveItemIndex >= sequence.items.length - 1}
            onClick={() => {
              if (runtimeActiveItemIndex < sequence.items.length - 1) void activateItem(sequence.items[runtimeActiveItemIndex + 1].id);
            }}
            className='flex h-8 w-8 items-center justify-center rounded-full border-0 bg-transparent p-0 text-text-secondary shadow-none transition-colors hover:translate-y-0 hover:scale-100 hover:text-text-primary disabled:opacity-30'
            aria-label='Next'
          >
            <SkipForward size={16} fill='currentColor' />
          </IconButton>
          {programSongPlayback?.isPlaying && typeof programSongPlayback.telemetryStale === 'boolean' ? (
            <div
              className={`flex items-center gap-1 whitespace-nowrap text-[9px] font-semibold uppercase tracking-wider ${programSongPlayback.telemetryStale ? 'text-amber-300' : 'text-emerald-300'}`}
            >
              <span
                className={`h-1.5 w-1.5 rounded-full ${programSongPlayback.telemetryStale ? 'bg-amber-300' : 'bg-emerald-300'}`}
                aria-hidden='true'
              />
              Feedback {programSongPlayback.telemetryStale ? 'stale' : 'live'}
            </div>
          ) : null}
        </div>

        <div className='hidden min-w-0 flex-1 px-4 md:block'>
          {programSongPlayback?.isPlaying && runtimeActiveItemId ? (
            (() => {
              const displayItem = sequence.items.find((i) => i.id === runtimeActiveItemId);
              if (!displayItem || displayItem.kind !== 'preset') return null;
              const songElapsedMs = Math.max(0, programSongPlayback.currentTimeMs);
              const totalMs =
                programSongPlayback?.isPlaying && typeof programSongPlayback.durationMs === 'number'
                  ? programSongPlayback.durationMs
                  : typeof displayItem.durationMs === 'number' && displayItem.durationMs > 0
                    ? displayItem.durationMs
                    : null;
              const hasTimeline = totalMs !== null && totalMs > 0;
              const clamped = hasTimeline ? Math.max(0, Math.min(songElapsedMs, totalMs)) : Math.max(0, songElapsedMs);
              const ratio = hasTimeline ? Math.max(0, Math.min(1, clamped / totalMs)) : 0;
              const fmt = (ms: number) => {
                const s = Math.floor(ms / 1000);
                return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
              };
              return (
                <div className='relative overflow-hidden rounded-lg border border-sand/30 bg-dark-sand/80'>
                  {hasTimeline && (
                    <div
                      className='pointer-events-none absolute inset-0 origin-left bg-sea/20'
                      style={{ transform: `scaleX(${ratio})`, transition: 'transform 90ms linear' }}
                    />
                  )}
                  <div className='relative flex items-center gap-2 px-3 py-2'>
                    {displayItem.coverUrl ? (
                      <img src={displayItem.coverUrl} alt='' className='h-8 w-8 shrink-0 rounded-sm object-cover' />
                    ) : (
                      <div className='flex h-8 w-8 shrink-0 items-center justify-center rounded-sm bg-dark-sand'>
                        <Music2 size={11} className='text-text-secondary' />
                      </div>
                    )}
                    <div className='min-w-0 flex-1'>
                      <div className='truncate text-xs font-semibold text-sea'>{displayItem.title || ''}</div>
                      <div className='truncate text-[10px] text-text-secondary'>{displayItem.artist || ''}</div>
                      {programSongPlayback?.introStatus === 'degraded' ? (
                        <div className='truncate text-[10px] font-medium text-amber-300'>
                          Intro unavailable{programSongPlayback.introFailureReason ? `: ${programSongPlayback.introFailureReason}` : ''}
                        </div>
                      ) : programSongPlayback?.introStatus === 'playing' ? (
                        <div className='text-[10px] font-medium text-violet-300'>Intro playing</div>
                      ) : null}
                    </div>
                    <div className='shrink-0 text-right text-[10px] tabular-nums text-text-secondary'>
                      {hasTimeline && (
                        <span>
                          {fmt(clamped)}
                          <span className='text-text-secondary/70'> / {fmt(totalMs)}</span>
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              );
            })()
          ) : (
            <p className='text-[11px] text-text-secondary'>Nothing on air</p>
          )}
        </div>

        <div className='order-1 flex w-full items-center justify-between gap-1 md:order-none md:w-auto md:justify-start md:gap-3'>
          <div
            className='flex min-w-0 flex-1 items-center gap-0.5 rounded-lg border border-sand/30 bg-dark-sand/80 p-0.5 md:flex-initial'
            role='group'
            aria-label='Playback mode'
          >
            <Button
              onClick={() =>
                applySequence({
                  ...sequence,
                  mode: 'manual',
                  activeItemId: runtimeActiveItemId ?? sequence.activeItemId,
                  startedAt: Date.now()
                })
              }
              aria-pressed={sequence.mode === 'manual'}
              className={`min-w-0 flex-1 rounded-md px-2 py-1 text-[11px] font-semibold transition-colors sm:px-2.5 md:flex-initial ${sequence.mode === 'manual' ? 'bg-sea text-white ring-1 ring-sea shadow-sm hover:bg-sea' : 'bg-transparent text-text-secondary shadow-none hover:text-text-primary'}`}
              size='sm'
              variant='secondary'
            >
              Manual
            </Button>
            <Button
              onClick={() =>
                applySequence({
                  ...sequence,
                  mode: 'autoplay',
                  activeItemId: runtimeActiveItemId ?? sequence.activeItemId,
                  startedAt: Date.now()
                })
              }
              aria-pressed={sequence.mode === 'autoplay'}
              className={`flex min-w-0 flex-1 items-center justify-center gap-1 rounded-md px-2 py-1 text-[11px] font-semibold transition-colors sm:px-2.5 md:flex-initial ${sequence.mode === 'autoplay' ? 'bg-sea text-white ring-1 ring-sea shadow-sm hover:bg-sea' : 'bg-transparent text-text-secondary shadow-none hover:text-text-primary'}`}
              size='sm'
              variant='secondary'
            >
              <Play size={9} fill='currentColor' /> Autoplay
            </Button>
            <Button
              onClick={() => {
                const shuffled = shuffleProgramSongSequence(sequence, runtimeActiveItemId ?? sequence.activeItemId ?? null);
                applySequence(programSongPlayback?.isPlaying ? shuffled : { ...shuffled, startedAt: Date.now() });
              }}
              disabled={sequence.items.length < 2}
              title={sequence.mode === 'shuffle' ? 'Shuffle is active; reshuffle playlist' : 'Activate shuffle'}
              aria-label='Shuffle playlist'
              aria-pressed={sequence.mode === 'shuffle'}
              className={`flex min-w-0 flex-1 items-center justify-center gap-1 rounded-md px-2 py-1 text-[11px] font-semibold transition-colors sm:px-2.5 md:flex-initial ${sequence.mode === 'shuffle' ? 'bg-sea text-white ring-1 ring-sea shadow-sm hover:bg-sea' : 'bg-transparent text-text-secondary shadow-none hover:text-text-primary'} disabled:cursor-not-allowed disabled:opacity-40`}
              size='sm'
              variant='secondary'
            >
              <Shuffle size={9} /> Shuffle
            </Button>
          </div>
          <Button
            type='button'
            title={sequence.loop !== false ? 'Loop is on' : 'Loop is off'}
            onClick={() => applySequence({ ...sequence, loop: sequence.loop === false ? true : false })}
            className={`flex h-8 items-center justify-center gap-1.5 rounded-lg px-2.5 text-[11px] font-semibold transition-colors ${sequence.loop !== false ? 'bg-sea text-white ring-1 ring-sea shadow-sm hover:bg-sea' : 'bg-transparent text-text-secondary shadow-none ring-1 ring-sand/30 hover:text-text-primary'}`}
            aria-label={`Loop playlist: ${sequence.loop !== false ? 'on' : 'off'}`}
            aria-pressed={sequence.loop !== false}
            size='sm'
            variant='secondary'
          >
            <Repeat2 size={14} />
            Loop {sequence.loop !== false ? 'on' : 'off'}
          </Button>
          {onStopAllInstants && (
            <IconButton
              type='button'
              title='Stop All Instants'
              onClick={() => onStopAllInstants()}
              className='flex h-8 w-8 items-center justify-center rounded-full transition-colors text-text-secondary hover:text-terracotta hover:bg-terracotta/10'
              aria-label='Stop All Instants'
            >
              <ZapOff size={16} />
            </IconButton>
          )}
        </div>
      </div>
    </div>
  );
}
