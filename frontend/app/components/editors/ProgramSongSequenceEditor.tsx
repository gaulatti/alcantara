import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, Input, Select } from '@gaulatti/bleecker';
import { Clock, GripVertical, Music2, Plus } from 'lucide-react';
import {
  createProgramSongSequence,
  createProgramSongSequenceItem,
  getProgramSongSequenceSelectedItemId,
  normalizeProgramSongSequence,
  type ProgramSongSequence,
  type ProgramSongSequenceItem
} from '../../utils/programSequence';
import type { SongCatalogItem, ProgramSongPlaybackState } from '../../models/broadcast';

function flattenProgramSongItems(items: ProgramSongSequenceItem[]): Extract<ProgramSongSequenceItem, { kind: 'preset' }>[] {
  const flat: Extract<ProgramSongSequenceItem, { kind: 'preset' }>[] = [];
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

export function ProgramSongSequenceEditor({
  sequence: _sequence,
  songCatalog = [],
  programSongPlayback = null,
  onChange,
  onTakeSelection,
  depth = 0,
  view = 'full'
}: {
  sequence: ProgramSongSequence;
  songCatalog?: SongCatalogItem[];
  programSongPlayback?: ProgramSongPlaybackState | null;
  onChange: (nextSequence: ProgramSongSequence) => void;
  onTakeSelection?: (nextSequence: ProgramSongSequence) => Promise<void> | void;
  depth?: number;
  view?: 'full' | 'catalog' | 'queue';
}) {
  const sequence = useMemo(() => {
    const n = normalizeProgramSongSequence(_sequence);
    return n ? normalizeProgramSongPlaylist(n) : { ...createProgramSongSequence('manual'), activeItemId: null };
  }, [_sequence]);

  const [draggingIndex, setDraggingIndex] = useState<number | null>(null);
  const [expandedItemId, setExpandedItemId] = useState<string | null>(null);
  const [addSongValue, setAddSongValue] = useState('');
  const isNested = depth > 0;
  const showQueue = view !== 'catalog';
  const showCatalog = view !== 'queue';
  const showQueueHeading = view === 'full';

  const editorActiveItemId = useMemo(() => {
    if (programSongPlayback?.isPlaying) {
      return sequence.activeItemId ?? (sequence.mode === 'autoplay' ? getProgramSongSequenceSelectedItemId(sequence, Date.now()) : null) ?? null;
    }
    return sequence.mode === 'autoplay'
      ? (getProgramSongSequenceSelectedItemId(sequence, Date.now()) ?? sequence.activeItemId ?? null)
      : (sequence.activeItemId ?? null);
  }, [programSongPlayback?.isPlaying, sequence]);

  const availableSongCatalog = useMemo(
    () =>
      songCatalog
        .filter((s) => s.enabled && typeof s.audioUrl === 'string' && s.audioUrl.trim().length > 0)
        .sort((a, b) =>
          [a.artist, a.title].filter(Boolean).join(' - ').toLowerCase().localeCompare([b.artist, b.title].filter(Boolean).join(' - ').toLowerCase())
        ),
    [songCatalog]
  );

  const catalogOptions = useMemo(
    () => availableSongCatalog.map((s) => ({ value: String(s.id), label: [s.artist, s.title].filter(Boolean).join(' - ') || `Song #${s.id}` })),
    [availableSongCatalog]
  );

  useEffect(() => {
    if (expandedItemId && !sequence.items.some((i) => i.id === expandedItemId)) setExpandedItemId(null);
  }, [sequence.items, expandedItemId]);

  const applySequence = useCallback(
    (nextSequence: ProgramSongSequence) => onChange(nextSequence),
    [onChange]
  );

  const resolveAutoplayStartedAt = useCallback((): number => {
    const now = Date.now();
    if (!programSongPlayback) return now;
    const targetId = editorActiveItemId ?? sequence.activeItemId;
    if (!targetId) return now;
    const target = sequence.items.find((i) => i.id === targetId);
    if (!target || target.kind !== 'preset') return now;
    const itemUrl = target.audioUrl?.trim() || '';
    const pbUrl = programSongPlayback.audioUrl?.trim() || '';
    const pbToken = programSongPlayback.token || '';
    const matches = (itemUrl && pbUrl && itemUrl === pbUrl) || (target.id && pbToken.startsWith(`${target.id}:`));
    if (!matches) return now;
    return now - Math.max(0, Math.round(programSongPlayback.currentTimeMs));
  }, [editorActiveItemId, programSongPlayback, sequence.activeItemId, sequence.items]);

  const addItem = useCallback(() => {
    const nextItem = createProgramSongSequenceItem('preset');
    if (nextItem.kind !== 'preset') return;
    const isAutoplay = sequence.mode === 'autoplay';
    const anchor = isAutoplay ? (editorActiveItemId ?? sequence.activeItemId ?? nextItem.id) : (editorActiveItemId ?? nextItem.id);
    applySequence({ ...sequence, items: [...sequence.items, nextItem], activeItemId: anchor, startedAt: isAutoplay ? resolveAutoplayStartedAt() : Date.now() });
  }, [applySequence, editorActiveItemId, resolveAutoplayStartedAt, sequence]);

  const addItemFromCatalog = useCallback(
    (songId: number) => {
      const selectedSong = availableSongCatalog.find((s) => s.id === songId);
      if (!selectedSong) return;
      const nextItem = createProgramSongSequenceItem('preset');
      if (nextItem.kind !== 'preset') return;
      const filled = {
        ...nextItem,
        artist: selectedSong.artist || '',
        title: selectedSong.title || '',
        coverUrl: selectedSong.coverUrl || '',
        audioUrl: selectedSong.audioUrl || '',
        durationMs:
          typeof selectedSong.durationMs === 'number' && Number.isFinite(selectedSong.durationMs) && selectedSong.durationMs > 0
            ? Math.round(selectedSong.durationMs)
            : nextItem.durationMs,
        earoneSongId: selectedSong.earoneSongId || nextItem.earoneSongId,
        earoneRank: selectedSong.earoneRank || nextItem.earoneRank,
        earoneSpins: selectedSong.earoneSpins || nextItem.earoneSpins
      };
      applySequence({
        ...sequence,
        items: [...sequence.items, filled],
        activeItemId: sequence.mode === 'autoplay' ? (editorActiveItemId ?? sequence.activeItemId ?? filled.id) : editorActiveItemId
      });
    },
    [applySequence, availableSongCatalog, editorActiveItemId, sequence]
  );

  const removeItem = useCallback(
    (index: number) => {
      const removed = sequence.items[index];
      if (!removed) return;
      const nextItems = sequence.items.filter((_, i) => i !== index);
      const isAutoplay = sequence.mode === 'autoplay';
      const current = isAutoplay ? (editorActiveItemId ?? sequence.activeItemId) : (editorActiveItemId ?? sequence.activeItemId);
      const removedCurrent = current !== null && current === removed.id;
      let nextActive: string | null;
      if (nextItems.length === 0) nextActive = null;
      else if (removedCurrent) nextActive = nextItems[Math.min(index, nextItems.length - 1)]?.id ?? null;
      else nextActive = current && nextItems.some((i) => i.id === current) ? current : (nextItems[0]?.id ?? null);
      applySequence({
        ...sequence,
        items: nextItems,
        activeItemId: nextActive,
        startedAt: isAutoplay && !removedCurrent ? resolveAutoplayStartedAt() : Date.now()
      });
    },
    [applySequence, editorActiveItemId, resolveAutoplayStartedAt, sequence]
  );

  const updateItem = useCallback(
    (index: number, updatedItem: ProgramSongSequenceItem) => {
      const nextItems = sequence.items.map((item, i) => (i === index ? updatedItem : item));
      applySequence({ ...sequence, items: nextItems });
    },
    [applySequence, sequence]
  );

  const reorderItems = useCallback(
    (fromIndex: number, toIndex: number) => {
      if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0 || fromIndex >= sequence.items.length || toIndex >= sequence.items.length) return;
      const next = [...sequence.items];
      const [moved] = next.splice(fromIndex, 1);
      next.splice(toIndex, 0, moved);
      applySequence({ ...sequence, items: next });
    },
    [applySequence, sequence]
  );

  const applyCatalogSongToItem = useCallback(
    (index: number, item: Extract<ProgramSongSequenceItem, { kind: 'preset' }>, song: SongCatalogItem) => {
      updateItem(index, {
        ...item,
        artist: song.artist || item.artist,
        title: song.title || item.title,
        coverUrl: song.coverUrl || item.coverUrl,
        audioUrl: song.audioUrl || item.audioUrl,
        durationMs:
          typeof song.durationMs === 'number' && Number.isFinite(song.durationMs) && song.durationMs > 0 ? Math.round(song.durationMs) : item.durationMs,
        earoneSongId: song.earoneSongId || item.earoneSongId,
        earoneRank: song.earoneRank || item.earoneRank,
        earoneSpins: song.earoneSpins || item.earoneSpins
      });
    },
    [updateItem]
  );

  function formatDurationFromMs(ms: number | null | undefined) {
    if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return '—';
    const totalSec = Math.round(ms / 1000);
    return `${Math.floor(totalSec / 60)}:${String(totalSec % 60).padStart(2, '0')}`;
  }

  return (
    <div className={`flex flex-col overflow-hidden rounded-xl ${isNested ? 'border border-sand/30 bg-dark-sand/70' : 'h-full min-h-0 bg-dark-sand'}`}>
      <div className='flex min-h-0 flex-1 flex-col md:flex-row'>
        {showQueue ? (
          <div className={`flex min-h-0 flex-1 flex-col ${showCatalog ? 'border-r-0 border-sand/30 md:border-r' : ''}`}>
            {showQueueHeading ? (
              <div className='flex items-center justify-between border-b border-sand/30 bg-dark-sand/70 px-4 py-2 border-t border-sand/20'>
                <span className='text-[10px] font-semibold uppercase tracking-widest text-text-secondary'>Playlist</span>
                <span className='text-[10px] text-text-secondary'>
                  {sequence.items.length} {sequence.items.length === 1 ? 'song' : 'songs'}
                </span>
              </div>
            ) : null}
            {sequence.items.length === 0 ? (
              <div className='flex flex-1 flex-col items-center justify-center px-4 py-16 text-center'>
                <Music2 size={32} className='mb-3 text-text-secondary' />
                <p className='text-sm font-medium text-text-primary'>Queue is empty</p>
                <p className='mt-1 text-xs text-text-secondary'>Search and add songs from the catalog panel.</p>
              </div>
            ) : (
              <div className='min-h-0 flex-1 overflow-auto'>
                <div className='min-w-100'>
                  <div className='grid grid-cols-[28px_28px_1fr_52px_56px] items-center border-b border-sand/30 px-3 py-1.5 text-[10px] font-medium uppercase tracking-widest text-text-secondary'>
                    <span />
                    <span className='text-center'>#</span>
                    <span style={{ paddingLeft: '50px' }}>Title</span>
                    <span className='flex items-center justify-end pr-3'>
                      <Clock size={10} />
                    </span>
                    <span />
                  </div>
                  <div className='divide-y divide-sand/20'>
                    {sequence.items.map((item, index) => {
                      const displayItem = item;
                      const isActive = displayItem.id === editorActiveItemId;
                      const isExpanded = displayItem.kind === 'preset' && expandedItemId === displayItem.id;
                      const selectedCatalogSong =
                        displayItem.kind === 'preset'
                          ? availableSongCatalog.find((song) => {
                              if (displayItem.audioUrl && song.audioUrl === displayItem.audioUrl) return true;
                              return (
                                (song.artist || '').trim() === displayItem.artist.trim() &&
                                (song.title || '').trim() === displayItem.title.trim() &&
                                (song.coverUrl || '').trim() === displayItem.coverUrl.trim()
                              );
                            })
                          : null;
                      const selectedCatalogSongValue = selectedCatalogSong ? String(selectedCatalogSong.id) : '';
                      const titleText = displayItem.kind === 'preset' ? displayItem.title.trim() : displayItem.label.trim();
                      const artistText = displayItem.kind === 'preset' ? displayItem.artist.trim() : '';
                      const rowDuration = displayItem.kind === 'preset' ? formatDurationFromMs(displayItem.durationMs) : '—';
                      const coverUrl = displayItem.kind === 'preset' ? displayItem.coverUrl.trim() : '';

                      return (
                        <div
                          key={displayItem.id}
                          onDragOver={(e) => e.preventDefault()}
                          onDrop={(e) => {
                            e.preventDefault();
                            if (draggingIndex !== null) reorderItems(draggingIndex, index);
                            setDraggingIndex(null);
                          }}
                        >
                          <div
                            className={`group grid grid-cols-[28px_28px_1fr_52px_56px] items-center px-3 py-1.5 transition-colors ${isActive ? 'bg-sea/15' : 'hover:bg-dark-sand/70'}`}
                          >
                            <span
                              draggable
                              onDragStart={() => setDraggingIndex(index)}
                              onDragEnd={() => setDraggingIndex(null)}
                              className='inline-flex h-6 w-6 cursor-grab select-none items-center justify-center text-text-secondary opacity-0 transition-opacity group-hover:opacity-100'
                              title='Drag to reorder'
                              aria-label='Drag to reorder'
                            >
                              <GripVertical size={12} strokeWidth={2} />
                            </span>
                            <Button
                              type='button'
                              onClick={() => {
                                const next = { ...sequence, activeItemId: displayItem.id, startedAt: Date.now() };
                                applySequence(next);
                                if (onTakeSelection) void onTakeSelection(next);
                              }}
                              className='relative flex h-6 w-6 shrink-0 items-center justify-center border-0 bg-transparent p-0 shadow-none hover:translate-y-0 hover:scale-100 hover:bg-transparent'
                              title='Take on air'
                              aria-label='Take on air'
                            >
                              <span
                                className={`text-xs tabular-nums transition-opacity ${isActive ? 'opacity-0' : 'text-text-secondary group-hover:opacity-0'}`}
                              >
                                {index + 1}
                              </span>
                              {isActive && (
                                <span className='absolute inset-0 flex items-end justify-center gap-0.5 pb-0.5 group-hover:opacity-0'>
                                  <span className='w-0.75 rounded-sm bg-sea opacity-100' style={{ animation: 'eq-bar1 0.8s ease-in-out infinite alternate' }} />
                                  <span
                                    className='w-0.75 rounded-sm bg-sea opacity-100'
                                    style={{ animation: 'eq-bar2 0.8s ease-in-out 0.15s infinite alternate' }}
                                  />
                                  <span
                                    className='w-0.75 rounded-sm bg-sea opacity-100'
                                    style={{ animation: 'eq-bar1 0.8s ease-in-out 0.3s infinite alternate' }}
                                  />
                                </span>
                              )}
                              <span className='absolute inset-0 flex items-center justify-center opacity-0 transition-opacity group-hover:opacity-100'>
                                <PlayIcon />
                              </span>
                            </Button>
                            <div className='flex min-w-0 items-center gap-2.5 pl-1'>
                              {coverUrl ? (
                                <img src={coverUrl} alt={`${artistText} - ${titleText}`} className='h-9 w-9 shrink-0 rounded-sm object-cover shadow-md' />
                              ) : (
                                <div className='flex h-9 w-9 shrink-0 items-center justify-center rounded-sm bg-dark-sand text-xs font-bold text-text-secondary'>
                                  {titleText.slice(0, 1).toUpperCase() || '?'}
                                </div>
                              )}
                              <div className='min-w-0'>
                                <div className={`truncate text-[13px] font-medium leading-tight ${isActive ? 'text-sea' : 'text-text-primary'}`}>
                                  {titleText}
                                </div>
                                <div className='truncate text-[11px] leading-tight text-text-secondary mt-0.5'>{artistText}</div>
                              </div>
                            </div>
                            <span className={`text-right pr-3 text-xs tabular-nums ${isActive ? 'text-sea' : 'text-text-secondary'}`}>{rowDuration}</span>
                            <div className='flex items-center justify-end gap-1 opacity-0 transition-opacity group-hover:opacity-100'>
                              {displayItem.kind === 'preset' ? (
                                <Button
                                  type='button'
                                  onClick={() => setExpandedItemId((prev) => (prev === displayItem.id ? null : displayItem.id))}
                                  className='flex h-6 w-6 items-center justify-center rounded border-0 bg-transparent p-0 text-text-secondary shadow-none transition-colors hover:translate-y-0 hover:scale-100 hover:text-text-primary'
                                  title='Edit song'
                                  aria-label='Edit song'
                                >
                                  <svg
                                    width='13'
                                    height='13'
                                    viewBox='0 0 24 24'
                                    fill='none'
                                    stroke='currentColor'
                                    strokeWidth='2'
                                    strokeLinecap='round'
                                    strokeLinejoin='round'
                                  >
                                    <path d='M12 20h9' />
                                    <path d='M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z' />
                                  </svg>
                                </Button>
                              ) : null}
                              <Button
                                type='button'
                                onClick={() => removeItem(index)}
                                className='flex h-6 w-6 items-center justify-center rounded border-0 bg-transparent p-0 text-text-secondary shadow-none transition-colors hover:translate-y-0 hover:scale-100 hover:text-terracotta'
                                title='Remove'
                                aria-label='Remove'
                              >
                                <svg
                                  width='13'
                                  height='13'
                                  viewBox='0 0 24 24'
                                  fill='none'
                                  stroke='currentColor'
                                  strokeWidth='2'
                                  strokeLinecap='round'
                                  strokeLinejoin='round'
                                >
                                  <polyline points='3 6 5 6 21 6' />
                                  <path d='M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6' />
                                  <path d='M10 11v6' />
                                  <path d='M14 11v6' />
                                  <path d='M9 6V4h6v2' />
                                </svg>
                              </Button>
                            </div>
                          </div>
                          {displayItem.kind === 'preset' && isExpanded ? (
                            <div className='border-t border-sand/30 bg-dark-sand/60 px-3 py-2'>
                              <div className='flex items-center rounded'>
                                <Select
                                  value={selectedCatalogSongValue}
                                  options={catalogOptions}
                                  placeholder='Swap song...'
                                  onChange={(v) => {
                                    const id = Number(v);
                                    if (Number.isFinite(id) && id > 0) {
                                      const song = availableSongCatalog.find((s) => s.id === id);
                                      if (song) {
                                        applyCatalogSongToItem(index, displayItem, song);
                                        setExpandedItemId(null);
                                      }
                                    }
                                  }}
                                />
                              </div>
                            </div>
                          ) : null}
                          {displayItem.kind === 'sequence' ? (
                            <div className='border-t border-sand/30 bg-dark-sand/70 px-4 py-3'>
                              <p className='mb-2 text-xs text-text-secondary'>Legacy nested sequence. Flatten if possible.</p>
                              <ProgramSongSequenceEditor
                                sequence={displayItem.sequence}
                                songCatalog={songCatalog}
                                depth={depth + 1}
                                onChange={(nextNested) => updateItem(index, { ...displayItem, sequence: nextNested })}
                                onTakeSelection={async (nextNested) => {
                                  const next = {
                                    ...sequence,
                                    items: sequence.items.map((e, i) => (i === index ? { ...displayItem, sequence: nextNested } : e))
                                  };
                                  applySequence(next);
                                  if (onTakeSelection) await onTakeSelection(next);
                                }}
                              />
                            </div>
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            )}
          </div>
        ) : null}

        {showCatalog ? (
          <div
            className={`flex min-h-0 flex-col border-t border-sand/30 bg-dark-sand/70 ${showQueue ? 'hidden w-[320px] shrink-0 md:flex' : 'min-h-0 flex-1'}`}
          >
            <div className='border-b border-sand/30 bg-dark-sand/80 p-2'>
              <Input
                type='text'
                placeholder='Search catalog to add...'
                value={addSongValue}
                onChange={(e) => setAddSongValue(e.target.value)}
                className='w-full rounded-md border border-sand/30 bg-dark-sand px-3 py-1.5 text-xs text-text-primary placeholder:text-text-secondary focus:border-sea/60 focus:outline-none focus:ring-1 focus:ring-sea/40'
              />
            </div>
            <div className={showQueue ? 'min-h-0 flex-1 overflow-y-auto' : 'max-h-125 overflow-y-auto'}>
              {availableSongCatalog
                .filter((s) => {
                  if (!addSongValue) return true;
                  const q = addSongValue.toLowerCase();
                  return s.title?.toLowerCase().includes(q) || s.artist?.toLowerCase().includes(q);
                })
                .slice(0, 80)
                .map((song) => (
                  <div key={song.id} className='group flex items-center justify-between border-b border-sand/20 px-3 py-2 hover:bg-dark-sand/70'>
                    <div className='flex min-w-0 items-center gap-2'>
                      {song.coverUrl ? (
                        <img src={song.coverUrl} alt='' className='h-8 w-8 shrink-0 rounded-sm object-cover opacity-80' />
                      ) : (
                        <div className='flex h-8 w-8 shrink-0 items-center justify-center rounded-sm bg-dark-sand text-text-secondary'>
                          {song.title?.charAt(0) || <Music2 size={12} />}
                        </div>
                      )}
                      <div className='min-w-0 pr-2'>
                        <div className='truncate text-[11px] font-medium text-text-primary'>{song.title}</div>
                        <div className='truncate text-[10px] text-text-secondary'>{song.artist}</div>
                      </div>
                    </div>
                    <Button
                      type='button'
                      onClick={() => addItemFromCatalog(song.id)}
                      className='flex h-6 w-6 shrink-0 items-center justify-center rounded-full border-0 bg-transparent p-0 text-text-secondary opacity-0 shadow-none transition-all hover:translate-y-0 hover:scale-100 hover:bg-sea/20 hover:text-sea group-hover:opacity-100'
                      title='Add to queue'
                      aria-label='Add to queue'
                    >
                      <Plus size={14} />
                    </Button>
                  </div>
                ))}
              {availableSongCatalog.length > 0 &&
                availableSongCatalog.filter(
                  (s) =>
                    !addSongValue || s.title?.toLowerCase().includes(addSongValue.toLowerCase()) || s.artist?.toLowerCase().includes(addSongValue.toLowerCase())
                ).length === 0 && <div className='p-4 text-center text-xs text-text-secondary'>No matches found</div>}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function PlayIcon() {
  return (
    <svg width='11' height='11' viewBox='0 0 24 24' fill='currentColor' className='text-text-primary'>
      <polygon points='5 3 19 12 5 21 5 3' />
    </svg>
  );
}
