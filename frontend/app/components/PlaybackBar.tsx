import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, IconButton } from '@gaulatti/bleecker';
import { Music2, Play, Repeat2, SkipBack, SkipForward, Square, ZapOff } from 'lucide-react';
import {
  createProgramSongSequence,
  getProgramSongSequenceSelectedItemId,
  normalizeProgramSongSequence,
  resolveProgramSongLeaf,
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
  onTakeScene,
}: PlaybackBarProps) {
  const sequence = useMemo(() => {
    const n = normalizeProgramSongSequence(_sequence);
    return n ? normalizeProgramSongPlaylist(n) : { ...createProgramSongSequence('manual'), activeItemId: null };
  }, [_sequence]);

  const [nowMs, setNowMs] = useState(() => Date.now());
  const [stickyPlaybackItemId, setStickyPlaybackItemId] = useState<string | null>(null);
  const songDurationByUrlRef = useRef<Record<string, number | null>>({});
  const autoTakeOffTimerRef = useRef<number | null>(null);
  const sequenceRef = useRef(sequence);
  const effectiveActiveItemId = getProgramSongSequenceSelectedItemId(sequence, nowMs);

  const showSceneQuickBar = sceneQuickActions.length > 0;

  const clearAutoTakeOffTimer = useCallback(() => {
    if (autoTakeOffTimerRef.current !== null) {
      window.clearTimeout(autoTakeOffTimerRef.current);
      autoTakeOffTimerRef.current = null;
    }
  }, []);

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
      return stickyPlaybackItemId ?? playbackActiveItemId ?? sequence.activeItemId ?? (sequence.mode === 'autoplay' ? effectiveActiveItemId : null) ?? null;
    }
    return sequence.mode === 'autoplay' ? (effectiveActiveItemId ?? sequence.activeItemId ?? null) : (sequence.activeItemId ?? null);
  }, [effectiveActiveItemId, playbackActiveItemId, programSongPlayback?.isPlaying, sequence.activeItemId, sequence.mode, stickyPlaybackItemId]);

  const runtimeActiveItemIndex = runtimeActiveItemId ? sequence.items.findIndex((i) => i.id === runtimeActiveItemId) : -1;

  useEffect(() => {
    sequenceRef.current = sequence;
  }, [sequence]);

  useEffect(() => {
    if (!sequence.activeItemId && !programSongPlayback?.isPlaying) return;
    const timer = setInterval(() => setNowMs(Date.now()), 250);
    return () => clearInterval(timer);
  }, [programSongPlayback?.isPlaying, sequence.activeItemId, sequence.startedAt]);

  const clearActiveItem = useCallback(async () => {
    clearAutoTakeOffTimer();
    const next = { ...sequence, mode: 'manual' as const, activeItemId: null };
    applySequence(next);
    if (onTakeSelection) await onTakeSelection(next);
    if (onTakeOffAir) await onTakeOffAir();
  }, [applySequence, clearAutoTakeOffTimer, onTakeOffAir, onTakeSelection, sequence]);

  const resolveAutoplayStartedAt = useCallback((): number => {
    const now = Date.now();
    if (!programSongPlayback) return now;
    const targetId = sequence.mode === 'autoplay' ? (runtimeActiveItemId ?? sequence.activeItemId ?? null) : (runtimeActiveItemId ?? sequence.activeItemId ?? null);
    if (!targetId) return now;
    const target = sequence.items.find((i) => i.id === targetId);
    if (!target || target.kind !== 'preset') return now;
    const itemUrl = target.audioUrl?.trim() || '';
    const pbUrl = programSongPlayback.audioUrl.trim();
    const pbToken = programSongPlayback.token;
    const matches = (itemUrl && pbUrl && itemUrl === pbUrl) || (target.id && pbToken.startsWith(`${target.id}:`));
    if (!matches) return now;
    return now - Math.max(0, Math.round(programSongPlayback.currentTimeMs));
  }, [programSongPlayback, runtimeActiveItemId, sequence.activeItemId, sequence.items, sequence.mode]);

  const scheduleAutoTakeOffForSequence = useCallback(
    (nextSequence: ProgramSongSequence) => {
      clearAutoTakeOffTimer();
      if (nextSequence.mode !== 'manual') return;
      const leaf = resolveProgramSongLeaf({ sequence: nextSequence }, Date.now());
      const durationMs = leaf?.durationMs;
      if (typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs <= 0) {
        const fallbackUrl = leaf?.audioUrl?.trim();
        if (!fallbackUrl) return;
        const cached = songDurationByUrlRef.current[fallbackUrl];
        if (typeof cached === 'number' && Number.isFinite(cached) && cached > 0) {
          const expectedId = nextSequence.activeItemId ?? null;
          const expectedStarted = typeof nextSequence.startedAt === 'number' && Number.isFinite(nextSequence.startedAt) ? nextSequence.startedAt : null;
          autoTakeOffTimerRef.current = window.setTimeout(
            () => {
              const cur = sequenceRef.current;
              if (cur.activeItemId !== expectedId) return;
              if ((typeof cur.startedAt === 'number' && Number.isFinite(cur.startedAt) ? cur.startedAt : null) !== expectedStarted) return;
              void clearActiveItem();
            },
            Math.max(200, Math.round(cached))
          );
          return;
        }
        const audio = new Audio();
        audio.preload = 'metadata';
        audio.onloadedmetadata = () => {
          const sec = Number(audio.duration);
          audio.onloadedmetadata = null;
          audio.onerror = null;
          audio.src = '';
          const d = Number.isFinite(sec) && sec > 0 ? Math.max(1, Math.round(sec * 1000)) : null;
          songDurationByUrlRef.current[fallbackUrl] = d;
          if (!d) return;
          const expectedId = nextSequence.activeItemId ?? null;
          const expectedStarted = typeof nextSequence.startedAt === 'number' && Number.isFinite(nextSequence.startedAt) ? nextSequence.startedAt : null;
          clearAutoTakeOffTimer();
          autoTakeOffTimerRef.current = window.setTimeout(
            () => {
              const cur = sequenceRef.current;
              if (cur.activeItemId !== expectedId) return;
              if ((typeof cur.startedAt === 'number' && Number.isFinite(cur.startedAt) ? cur.startedAt : null) !== expectedStarted) return;
              void clearActiveItem();
            },
            Math.max(200, d)
          );
        };
        audio.onerror = () => {
          audio.onloadedmetadata = null;
          audio.onerror = null;
          audio.src = '';
          songDurationByUrlRef.current[fallbackUrl] = null;
        };
        audio.src = fallbackUrl;
        audio.load();
        return;
      }
      const expectedId = nextSequence.activeItemId ?? null;
      const expectedStarted = typeof nextSequence.startedAt === 'number' && Number.isFinite(nextSequence.startedAt) ? nextSequence.startedAt : null;
      autoTakeOffTimerRef.current = window.setTimeout(
        () => {
          const cur = sequenceRef.current;
          if (cur.activeItemId !== expectedId) return;
          if ((typeof cur.startedAt === 'number' && Number.isFinite(cur.startedAt) ? cur.startedAt : null) !== expectedStarted) return;
          void clearActiveItem();
        },
        Math.max(200, Math.round(durationMs))
      );
    },
    [clearActiveItem, clearAutoTakeOffTimer]
  );

  const activateItem = useCallback(
    async (itemId: string) => {
      clearAutoTakeOffTimer();
      const next = { ...sequence, activeItemId: itemId, startedAt: Date.now() };
      applySequence(next);
      if (onTakeSelection) await onTakeSelection(next);
      scheduleAutoTakeOffForSequence(next);
    },
    [applySequence, clearAutoTakeOffTimer, onTakeSelection, scheduleAutoTakeOffForSequence, sequence]
  );

  useEffect(() => {
    if (sequence.activeItemId && !programSongPlayback?.isPlaying && sequence.mode === 'manual') {
      const leaf = resolveProgramSongLeaf({ sequence }, Date.now());
      const dur = leaf?.durationMs;
      if (dur && Number.isFinite(dur) && dur > 0) {
        const elapsed = Date.now() - (sequence.startedAt ?? Date.now());
        if (elapsed >= dur) void clearActiveItem();
      }
    }
  }, [clearActiveItem, programSongPlayback?.isPlaying, sequence]);

  return (
    <div className='bg-dark-sand/95 shadow-[0_-10px_28px_rgba(0,0,0,0.45)] backdrop-blur supports-[backdrop-filter]:bg-dark-sand/90'>
      {showSceneQuickBar ? (
        <div className='border-t border-sand/30 bg-dark-sand/90 px-4 py-2'>
          <div className='flex items-center gap-2 overflow-x-auto'>
            {sceneQuickActions.map((a) => (
              <Button
                key={a.id}
                onClick={() => onStageScene?.(a.id)}
                onDoubleClick={() => onTakeScene?.(a.id)}
                title={`${a.name} (click to stage, double-click to take)`}
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
      <div className='flex items-center justify-between border-t border-sand/30 bg-dark-sand/85 px-4 py-3'>
        <div className='flex items-center gap-2'>
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
            title={runtimeActiveItemId ? 'Next / Advance' : 'Play'}
            onClick={() => {
              if (!runtimeActiveItemId && sequence.items.length > 0) void activateItem(sequence.items[0].id);
              else if (runtimeActiveItemId) {
                const idx = sequence.items.findIndex((i) => i.id === runtimeActiveItemId);
                if (idx < sequence.items.length - 1) void activateItem(sequence.items[idx + 1].id);
                else void activateItem(sequence.items[0].id);
              }
            }}
            className='flex h-10 w-10 items-center justify-center rounded-full border-0 bg-sea p-0 text-white shadow-lg transition-transform hover:translate-y-0 hover:scale-105 hover:bg-accent-blue active:scale-95'
            aria-label={runtimeActiveItemId ? 'Next / Advance' : 'Play'}
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
        </div>

        <div className='hidden min-w-0 flex-1 px-4 md:block'>
          {runtimeActiveItemId ? (
            (() => {
              const displayItem = sequence.items.find((i) => i.id === runtimeActiveItemId);
              if (!displayItem || displayItem.kind !== 'preset') return null;
              const displayUrl = displayItem.audioUrl?.trim() || '';
              const pbUrl = programSongPlayback?.audioUrl?.trim() || '';
              const pbToken = programSongPlayback?.token || '';
              const matchesPlayback =
                !!programSongPlayback &&
                ((displayUrl && pbUrl && displayUrl === pbUrl) ||
                  (displayItem.id && pbToken.startsWith(`${displayItem.id}:`)) ||
                  (runtimeActiveItemId === displayItem.id && programSongPlayback.isPlaying));
              let songElapsedMs = 0;
              let songStartedAt = typeof sequence.startedAt === 'number' ? sequence.startedAt : nowMs;
              if (matchesPlayback && programSongPlayback) {
                songElapsedMs = Math.max(0, programSongPlayback.currentTimeMs);
                songStartedAt = Math.max(0, nowMs - songElapsedMs);
              } else if (programSongPlayback?.isPlaying) {
                songElapsedMs = Math.max(0, programSongPlayback.currentTimeMs);
                songStartedAt = Math.max(0, nowMs - songElapsedMs);
              } else if (sequence.mode === 'autoplay' && typeof sequence.startedAt === 'number') {
                const totalElapsed = Math.max(0, nowMs - sequence.startedAt);
                const baseIdx = sequence.items.findIndex((i) => i.id === runtimeActiveItemId);
                const startIdx = baseIdx >= 0 ? baseIdx : 0;
                const itemDurations = sequence.items.map((i) =>
                  i.kind === 'preset' && typeof i.durationMs === 'number' && i.durationMs > 0 ? i.durationMs : null
                );
                const allKnown = itemDurations.every((d) => d !== null);
                let remaining = totalElapsed;
                let cycleOffset = 0;
                if (allKnown && sequence.loop !== false) {
                  const cycle = itemDurations.reduce((s, d) => s + (d ?? 0), 0);
                  if (cycle > 0) {
                    remaining = totalElapsed % cycle;
                    cycleOffset = totalElapsed - remaining;
                  }
                }
                let cumulative = 0;
                for (let step = 0; step < sequence.items.length; step++) {
                  const idx = (startIdx + step) % sequence.items.length;
                  const dur = itemDurations[idx];
                  if (dur === null || remaining < dur) {
                    songStartedAt = sequence.startedAt + cycleOffset + cumulative;
                    songElapsedMs = remaining;
                    break;
                  }
                  remaining -= dur;
                  cumulative += dur;
                }
              } else {
                songElapsedMs = Math.max(0, nowMs - songStartedAt);
              }
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

        <div className='flex items-center gap-3'>
          <div className='flex items-center gap-0.5 rounded-lg border border-sand/30 bg-dark-sand/80 p-0.5'>
            <Button
              onClick={() =>
                applySequence({
                  ...sequence,
                  mode: 'manual',
                  activeItemId:
                    sequence.mode === 'autoplay' ? (runtimeActiveItemId ?? sequence.activeItemId) : (runtimeActiveItemId ?? sequence.activeItemId),
                  startedAt: Date.now()
                })
              }
              className={`rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors ${sequence.mode === 'manual' ? 'bg-sea/20 text-sea shadow-sm' : 'text-text-secondary hover:text-text-primary'}`}
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
                  activeItemId:
                    sequence.mode === 'autoplay' ? (runtimeActiveItemId ?? sequence.activeItemId) : (runtimeActiveItemId ?? sequence.activeItemId),
                  startedAt: resolveAutoplayStartedAt()
                })
              }
              className={`flex items-center gap-1 rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors ${sequence.mode === 'autoplay' ? 'bg-sea/20 text-sea' : 'text-text-secondary hover:text-text-primary'}`}
              size='sm'
              variant='secondary'
            >
              <Play size={9} fill='currentColor' /> Autoplay
            </Button>
          </div>
          <IconButton
            type='button'
            title='Loop'
            onClick={() => applySequence({ ...sequence, loop: sequence.loop === false ? true : false })}
            className={`flex h-8 w-8 items-center justify-center rounded-full transition-colors ${sequence.loop !== false ? 'text-sea bg-sea/10' : 'text-text-secondary hover:text-text-primary'}`}
            aria-label='Loop'
          >
            <Repeat2 size={16} />
          </IconButton>
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
