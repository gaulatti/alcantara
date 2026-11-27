import { StatePill } from '../radio-desk/primitives';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, Input, Select } from '@gaulatti/bleecker';
import { Check, ChevronDown, ChevronUp, Clock, GripVertical, Headphones, ListPlus, Music2, Plus, Star } from 'lucide-react';

/** How long Undo offers to put back a song that was removed from a rotation. */
const UNDO_MS = 8_000;

type PendingUndo = { item: ProgramSongSequenceLeafItem; index: number; expiresAt: number; wasPlayNext?: boolean };

// The pending undo lives in sessionStorage, so a reload inside the window still offers it. Storage that cannot be
// read or written leaves the undo offer off; the removal itself is saved either way.
function readPendingUndo(key: string): PendingUndo | null {
  try {
    const raw = window.sessionStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PendingUndo;
    if (typeof parsed.expiresAt !== 'number' || parsed.expiresAt <= Date.now()) {
      window.sessionStorage.removeItem(key);
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function writePendingUndo(key: string, value: PendingUndo | null): void {
  try {
    if (value) window.sessionStorage.setItem(key, JSON.stringify(value));
    else window.sessionStorage.removeItem(key);
  } catch {
    // Storage unavailable: the undo still works until the page reloads.
  }
}
import {
  createProgramSongSequence,
  createProgramSongSequenceItem,
  getProgramSongSequenceSelectedItemId,
  normalizeProgramSongSequence,
  programSongPlayOrder,
  songIdsInProgramSongSequence,
  type ProgramSongSequence,
  type ProgramSongSequenceItem,
  type ProgramSongSequenceLeafItem
} from '../../utils/programSequence';
import type { SongCatalogItem, ProgramSongPlaybackState } from '../../models/broadcast';

/** A song sequence flattened to its songs: legacy nested blocks are inlined. */
type ProgramSongPlaylist = Omit<ProgramSongSequence, 'items'> & { items: ProgramSongSequenceLeafItem[] };

function flattenProgramSongItems(items: ProgramSongSequenceItem[]): ProgramSongSequenceLeafItem[] {
  const flat: ProgramSongSequenceLeafItem[] = [];
  for (const item of items) {
    if (item.kind === 'preset') {
      flat.push(item);
      continue;
    }
    flat.push(...flattenProgramSongItems(item.sequence.items));
  }
  return flat;
}

function normalizeProgramSongPlaylist(sequence: ProgramSongSequence): ProgramSongPlaylist {
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
  onQueueItem,
  playNextIds,
  depth = 0,
  view = 'full',
  rotationLabel = 'Playlist',
  undoScope,
  liveItemId,
  nextItemId = null
}: {
  sequence: ProgramSongSequence;
  songCatalog?: SongCatalogItem[];
  programSongPlayback?: ProgramSongPlaybackState | null;
  onChange: (nextSequence: ProgramSongSequence) => void;
  onTakeSelection?: (nextSequence: ProgramSongSequence) => Promise<void> | void;
  onQueueItem?: (itemId: string) => Promise<void> | void;
  /** The rotation items that are queued as Play Next. Removing one takes its entry with it, so Undo queues it again. */
  playNextIds?: string[];
  depth?: number;
  view?: 'full' | 'catalog' | 'queue';
  rotationLabel?: string;
  /** The program the rotation belongs to. A pending Undo is kept per program, so it never lands in another one. */
  undoScope: string;
  /** The rotation song that is on air, and the one Cue next would cue: marked in the list (#298). */
  liveItemId?: string | null;
  nextItemId?: string | null;
}) {
  // Every item the editor shows is a song: the playlist type proves it.
  const sequence = useMemo(
    () => normalizeProgramSongPlaylist(normalizeProgramSongSequence(_sequence) ?? { ...createProgramSongSequence('manual'), activeItemId: null }),
    [_sequence]
  );

  const [draggingIndex, setDraggingIndex] = useState<number | null>(null);
  const [expandedItemId, setExpandedItemId] = useState<string | null>(null);
  const undoKey = `alcantara.rotationUndo.${undoScope}.${rotationLabel}`;
  const [pendingUndo, setPendingUndo] = useState<PendingUndo | null>(() => readPendingUndo(undoKey));
  // A different program (or rotation) is a different Undo: take up its own pending offer, never the last one's.
  useEffect(() => {
    setPendingUndo(readPendingUndo(undoKey));
  }, [undoKey]);

  useEffect(() => {
    if (!pendingUndo) return;
    const timer = setTimeout(() => {
      setPendingUndo(null);
      writePendingUndo(undoKey, null);
    }, Math.max(0, pendingUndo.expiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [pendingUndo, undoKey]);
  const [addSongValue, setAddSongValue] = useState('');
  const [previewingItemId, setPreviewingItemId] = useState<string | null>(null);
  const previewAudioRef = useRef<HTMLAudioElement | null>(null);
  const isNested = depth > 0;
  const showQueue = view !== 'catalog';
  const showCatalog = view !== 'queue';
  const showQueueHeading = view === 'full' || rotationLabel !== 'Playlist';
  const isAutomatic = sequence.mode === 'autoplay' || sequence.mode === 'shuffle';
  const highRotationCount = useMemo(
    () => sequence.items.filter((item) => item.highRotation).length,
    [sequence.items]
  );

  const editorActiveItemId = useMemo(() => {
    if (programSongPlayback?.isPlaying) {
      const playbackItem = sequence.items.find((item) => programSongPlayback.token?.startsWith(`${item.id}:`));
      if (playbackItem) return playbackItem.id;
      const byUrl = sequence.items.filter((item) => item.audioUrl === programSongPlayback.audioUrl);
      return byUrl.length === 1 ? byUrl[0].id : null;
    }
    return sequence.activeItemId ?? (isAutomatic ? getProgramSongSequenceSelectedItemId(sequence, Date.now()) : null) ?? null;
  }, [isAutomatic, programSongPlayback?.isPlaying, programSongPlayback?.token, programSongPlayback?.audioUrl, sequence]);

  const availableSongCatalog = useMemo(
    () =>
      songCatalog
        .filter((s) => s.enabled && typeof s.audioUrl === 'string' && s.audioUrl.trim().length > 0)
        .sort((a, b) =>
          [a.artist, a.title].filter(Boolean).join(' - ').toLowerCase().localeCompare([b.artist, b.title].filter(Boolean).join(' - ').toLowerCase())
        ),
    [songCatalog]
  );

  // A song goes into a playlist once (gaulatti/alcantara#280): the picker says so and the server refuses a repeat.
  const songIdsInPlaylist = useMemo(() => songIdsInProgramSongSequence(sequence), [sequence]);

  const catalogOptions = useMemo(
    () => availableSongCatalog.map((s) => ({ value: String(s.id), label: [s.artist, s.title].filter(Boolean).join(' - ') || `Song #${s.id}` })),
    [availableSongCatalog]
  );

  useEffect(() => {
    if (expandedItemId && !sequence.items.some((i) => i.id === expandedItemId)) setExpandedItemId(null);
  }, [sequence.items, expandedItemId]);

  useEffect(() => {
    return () => {
      previewAudioRef.current?.pause();
      previewAudioRef.current = null;
    };
  }, []);

  const applySequence = useCallback(
    (nextSequence: ProgramSongSequence) => onChange(nextSequence),
    [onChange]
  );

  const previewItem = useCallback(async (item: ProgramSongSequenceLeafItem) => {
    // The preview button is disabled while the item has no audio URL, so this runs only with one.
    const audioUrl = (item.audioUrl as string).trim();

    if (previewingItemId === item.id) {
      previewAudioRef.current?.pause();
      previewAudioRef.current = null;
      setPreviewingItemId(null);
      return;
    }

    previewAudioRef.current?.pause();
    const audio = new Audio(audioUrl);
    previewAudioRef.current = audio;
    audio.onended = () => {
      if (previewAudioRef.current === audio) {
        previewAudioRef.current = null;
        setPreviewingItemId(null);
      }
    };
    audio.onerror = () => {
      if (previewAudioRef.current === audio) {
        previewAudioRef.current = null;
        setPreviewingItemId(null);
      }
    };

    try {
      await audio.play();
      if (previewAudioRef.current === audio) setPreviewingItemId(item.id);
    } catch (error) {
      if (previewAudioRef.current === audio) {
        previewAudioRef.current = null;
        setPreviewingItemId(null);
      }
      console.error('Failed to play local song preview:', error);
    }
  }, [previewingItemId]);

  const resolveAutoplayStartedAt = useCallback((): number => {
    const now = Date.now();
    if (!programSongPlayback) return now;
    const targetId = editorActiveItemId ?? sequence.activeItemId;
    if (!targetId) return now;
    const target = sequence.items.find((i) => i.id === targetId);
    if (!target) return now;
    const itemUrl = target.audioUrl?.trim() || '';
    const pbUrl = programSongPlayback.audioUrl?.trim() || '';
    const pbToken = programSongPlayback.token || '';
    const matches = (itemUrl && pbUrl && itemUrl === pbUrl) || (target.id && pbToken.startsWith(`${target.id}:`));
    if (!matches) return now;
    return now - Math.max(0, Math.round(programSongPlayback.currentTimeMs));
  }, [editorActiveItemId, programSongPlayback, sequence.activeItemId, sequence.items]);

  const addItemFromCatalog = useCallback(
    (selectedSong: SongCatalogItem) => {
      // The add button is rendered per catalog song and disabled once the song is in the playlist.
      // A new preset item is always a preset.
      const nextItem = createProgramSongSequenceItem('preset') as Extract<ProgramSongSequenceLeafItem, { kind: 'preset' }>;
      const filled = {
        ...nextItem,
        songId: selectedSong.id,
        artist: selectedSong.artist || '',
        title: selectedSong.title || '',
        coverUrl: selectedSong.coverUrl || '',
        /* v8 ignore next -- the catalog list offers only enabled songs with audio (see the catalog filter), so selectedSong.audioUrl is always set here; the '' fallback is defensive. */
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
        activeItemId: isAutomatic ? (editorActiveItemId ?? sequence.activeItemId ?? filled.id) : editorActiveItemId
      });
    },
    [applySequence, editorActiveItemId, isAutomatic, sequence]
  );

  const removeItem = useCallback(
    (index: number) => {
      // Called only from the items map, so index always names an existing item.
      const removed = sequence.items[index];
      const nextItems = sequence.items.filter((_, i) => i !== index);
      // A Play Next song on air did not move the cursor: only the cursor says which row is current then.
      const queued = !!programSongPlayback?.queueEntryId;
      const current = queued ? sequence.activeItemId : (editorActiveItemId ?? sequence.activeItemId);
      const removedCurrent = current !== null && current === removed.id;
      let nextActive: string | null;
      // The engine reads the cursor as the song on air and arms the one after it. Removing the song on air from an
      // automatic rotation moved the cursor to its successor, so the successor was skipped (walk part 5): the cursor
      // goes to its predecessor in the order that plays instead, and the successor is what follows.
      const order = programSongPlayOrder(sequence);
      const place = order.findIndex((i) => i.id === removed.id);
      const predecessor =
        place > 0 ? order[place - 1] : sequence.loop !== false && order.length > 1 ? order[order.length - 1] : null;
      // Only the rotation's own song on air has aired; a pending cursor row removed under another song moves forward.
      const removedOnAir =
        removedCurrent && isAutomatic && programSongPlayback?.isPlaying === true && !queued && editorActiveItemId === removed.id;
      if (nextItems.length === 0) nextActive = null;
      else if (removedOnAir && predecessor) nextActive = predecessor.id;
      // nextItems is non-empty past the first branch, and the index is clamped to it.
      else if (removedCurrent) nextActive = nextItems[Math.min(index, nextItems.length - 1)].id;
      else nextActive = current && nextItems.some((i) => i.id === current) ? current : nextItems[0].id;
      applySequence({
        ...sequence,
        items: nextItems,
        activeItemId: nextActive,
        // The cursor moved on to the row after the removed one, which has not aired: the engine and the desk are told.
        ...(removedCurrent && !(removedOnAir && predecessor) && index < nextItems.length ? { cuedItemId: nextActive! } : {}),
        startedAt: isAutomatic && !removedCurrent ? resolveAutoplayStartedAt() : Date.now()
      });
      // The removal is saved at once. Undo puts the song back at its place for UNDO_MS, and survives a reload in that window.
      const undo = { item: removed, index, expiresAt: Date.now() + UNDO_MS, wasPlayNext: !!playNextIds?.includes(removed.id) };
      setPendingUndo(undo);
      writePendingUndo(undoKey, undo);
    },
    [applySequence, editorActiveItemId, isAutomatic, playNextIds, programSongPlayback?.isPlaying, programSongPlayback?.queueEntryId, resolveAutoplayStartedAt, sequence, undoKey]
  );

  const undoRemove = useCallback(() => {
    if (!pendingUndo) return;
    const { item, index } = pendingUndo;
    setPendingUndo(null);
    writePendingUndo(undoKey, null);
    if (sequence.items.some((i) => i.id === item.id)) return;
    const nextItems = [...sequence.items];
    nextItems.splice(Math.min(index, nextItems.length), 0, item);
    applySequence({ ...sequence, items: nextItems });
    if (pendingUndo.wasPlayNext && onQueueItem) void onQueueItem(item.id);
  }, [applySequence, onQueueItem, pendingUndo, sequence, undoKey]);

  const updateItem = useCallback(
    (index: number, updatedItem: ProgramSongSequenceLeafItem) => {
      const nextItems = sequence.items.map((item, i) => (i === index ? updatedItem : item));
      applySequence({ ...sequence, items: nextItems });
    },
    [applySequence, sequence]
  );

  const toggleHighRotation = useCallback(
    (index: number, item: ProgramSongSequenceLeafItem) => {
      // The button is disabled at the 12-song limit, so this only adds below it.
      updateItem(index, { ...item, highRotation: !item.highRotation });
    },
    [updateItem]
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
    (index: number, item: ProgramSongSequenceLeafItem, song: SongCatalogItem) => {
      updateItem(index, {
        ...item,
        songId: song.id,
        artist: song.artist || item.artist,
        title: song.title || item.title,
        coverUrl: song.coverUrl || item.coverUrl,
        /* v8 ignore next -- the catalog offers only songs with audio, so song.audioUrl is always set when this swap runs; the item fallback is defensive. */
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
                <span className='text-[10px] font-semibold uppercase tracking-widest text-text-secondary'>{rotationLabel}</span>
                <span className='text-[10px] text-text-secondary'>
                  {sequence.items.length} {sequence.items.length === 1 ? 'song' : 'songs'}
                </span>
              </div>
            ) : null}
            {pendingUndo ? (
              <div role='status' className='flex items-center justify-between gap-3 border-b border-sand/30 bg-dark-sand/70 px-4 py-2 text-xs text-text-primary'>
                <span>Removed {pendingUndo.item.title.trim() || 'song'} from {rotationLabel.toLowerCase()}.</span>
                <Button type='button' size='xs' variant='secondary' onClick={undoRemove}>
                  Undo
                </Button>
              </div>
            ) : null}
            {sequence.items.length === 0 ? (
              <div className='flex flex-1 flex-col items-center justify-center px-4 py-16 text-center'>
                <Music2 size={32} className='mb-3 text-text-secondary' />
                <p className='text-sm font-medium text-text-primary'>{rotationLabel} is empty</p>
                <p className='mt-1 text-xs text-text-secondary'>{rotationLabel === 'Playlist' ? 'Search and add songs from the catalog panel.' : 'Use Add fillers to choose Library songs.'}</p>
              </div>
            ) : (
              <div className='min-h-0 flex-1 overflow-auto'>
                <div className='playlist-table min-w-100'>
                  <div className='playlist-column-heading grid grid-cols-[28px_28px_28px_28px_minmax(0,1fr)_52px_auto] items-center border-b border-sand/30 px-3 py-1.5 text-[10px] font-medium uppercase tracking-widest text-text-secondary'>
                    <span />
                    <span className='text-center'>#</span>
                    <span />
                    <span className='text-center' title='High rotation favorites'>
                      ★
                    </span>
                    <span style={{ paddingLeft: '22px' }}>Title · High rotation {highRotationCount}/12</span>
                    <span className='flex items-center justify-end pr-3'>
                      <Clock size={10} />
                    </span>
                    <span />
                  </div>
                  <div className='divide-y divide-sand/20'>
                    {sequence.items.map((item, index) => {
                      const displayItem = item;
                      const isActive = displayItem.id === editorActiveItemId;
                      const isExpanded = expandedItemId === displayItem.id;
                      const selectedCatalogSong = availableSongCatalog.find((song) => {
                        if (displayItem.songId === song.id) return true;
                        if (displayItem.audioUrl && song.audioUrl === displayItem.audioUrl) return true;
                        return (
                          (song.artist || '').trim() === displayItem.artist.trim() &&
                          (song.title || '').trim() === displayItem.title.trim() &&
                          (song.coverUrl || '').trim() === displayItem.coverUrl.trim()
                        );
                      });
                      const selectedCatalogSongValue = selectedCatalogSong ? String(selectedCatalogSong.id) : '';
                      const titleText = displayItem.title.trim();
                      const artistText = displayItem.artist.trim();
                      // A stored item may carry no length; the library song and, for the song on air, the playback do.
                      const rowDuration = formatDurationFromMs(
                        displayItem.durationMs ||
                          selectedCatalogSong?.durationMs ||
                          (displayItem.id === liveItemId ? programSongPlayback?.durationMs : undefined)
                      );
                      // Bars say "this is playing". The radio desk says which item is on air (`liveItemId`); a console
                      // that does not keeps them on the selected item.
                      const showsBars = liveItemId === undefined ? isActive : displayItem.id === liveItemId;
                      const coverUrl = displayItem.coverUrl.trim();

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
                            data-active={isActive}
                            className={`playlist-row group grid grid-cols-[28px_28px_28px_28px_minmax(0,1fr)_52px_auto] items-center px-3 py-1.5 transition-colors ${isActive ? 'bg-sea/15' : 'hover:bg-dark-sand/70'}`}
                          >
                            <span
                              draggable
                              onDragStart={() => setDraggingIndex(index)}
                              onDragEnd={() => setDraggingIndex(null)}
                              className='inline-flex h-6 w-6 cursor-grab select-none items-center justify-center text-text-secondary'
                              title='Drag to reorder'
                              aria-label='Drag to reorder'
                            >
                              <GripVertical size={12} strokeWidth={2} />
                            </span>
                            <Button
                              type='button'
                              onClick={() => {
                                const next = { ...sequence, activeItemId: displayItem.id, startedAt: Date.now() };
                                if (onTakeSelection) void onTakeSelection(next);
                                else applySequence(next);
                              }}
                              className='relative flex h-6 w-6 shrink-0 pointer-coarse:h-11 pointer-coarse:w-8 items-center justify-center border-0 bg-transparent p-0 shadow-none hover:translate-y-0 hover:scale-100 hover:bg-transparent'
                              title='Take on air'
                              aria-label='Take on air'
                            >
                              <span
                                className={`text-xs tabular-nums transition-opacity ${isActive || showsBars ? 'opacity-0' : 'text-text-secondary group-hover:opacity-0'}`}
                              >
                                {index + 1}
                              </span>
                              {isActive && !showsBars && (
                                // The selected item that is not on air shows what pressing it does.
                                <span data-testid='take-icon' className='absolute inset-0 flex items-center justify-center text-sea group-hover:opacity-0'>
                                  <PlayIcon />
                                </span>
                              )}
                              {showsBars && (
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
                            <Button
                              type='button'
                              onClick={() => void previewItem(displayItem)}
                              disabled={!displayItem.audioUrl?.trim()}
                              className={`flex h-6 w-6 shrink-0 pointer-coarse:h-11 pointer-coarse:w-8 items-center justify-center border-0 bg-transparent p-0 shadow-none hover:translate-y-0 hover:scale-100 hover:bg-transparent ${previewingItemId === displayItem.id ? 'text-sea' : 'text-text-secondary hover:text-text-primary'}`}
                              title={previewingItemId === displayItem.id ? 'Stop local preview' : 'Preview locally'}
                              aria-label={previewingItemId === displayItem.id ? 'Stop local preview' : 'Preview locally'}
                            >
                              <Headphones size={13} />
                            </Button>
                            <Button
                              type='button'
                              onClick={() => toggleHighRotation(index, displayItem)}
                              disabled={!displayItem.highRotation && highRotationCount >= 12}
                              className={`flex h-6 w-6 shrink-0 pointer-coarse:h-11 pointer-coarse:w-8 items-center justify-center border-0 bg-transparent p-0 shadow-none transition-colors hover:translate-y-0 hover:scale-100 hover:bg-transparent ${displayItem.highRotation ? 'text-amber-300' : 'text-text-secondary opacity-0 group-hover:opacity-100 [@media(hover:none)]:opacity-100'} disabled:cursor-not-allowed disabled:opacity-30`}
                              title={
                                displayItem.highRotation
                                  ? 'Remove from high rotation'
                                  : highRotationCount >= 12
                                    ? 'High rotation is limited to 12 songs'
                                    : 'Add to high rotation'
                              }
                              aria-label={`${displayItem.highRotation ? 'Remove' : 'Add'} ${titleText || 'song'} ${displayItem.highRotation ? 'from' : 'to'} high rotation`}
                            >
                              <Star size={13} fill={displayItem.highRotation ? 'currentColor' : 'none'} />
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
                                <div className={`flex items-center gap-2 truncate text-[13px] font-medium leading-tight ${isActive ? 'text-sea' : 'text-text-primary'}`}>
                                  <span className='truncate'>{titleText}</span>
                                  {displayItem.id === liveItemId ? (
                                    <StatePill tone='live' label='On air' pulse />
                                  ) : displayItem.id === nextItemId ? (
                                    <StatePill tone='info' label='Next' />
                                  ) : null}
                                </div>
                                <div className='truncate text-[11px] leading-tight text-text-secondary mt-0.5'>{artistText}</div>
                              </div>
                            </div>
                            <span className={`text-right pr-3 text-xs tabular-nums ${isActive ? 'text-sea' : 'text-text-secondary'}`}>{rowDuration}</span>
                            <div className='playlist-row-actions flex shrink-0 flex-nowrap items-center justify-end gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100 [@media(hover:none)]:opacity-100'>
                              {/* Move up and down are the keyboard and touch way to reorder; they use the same
                                  reorderItems as drag, so the new order persists the same way. */}
                              <Button
                                type='button'
                                onClick={() => reorderItems(index, index - 1)}
                                disabled={index === 0}
                                className='flex h-6 w-6 pointer-coarse:h-11 pointer-coarse:w-8 items-center justify-center rounded border-0 bg-transparent p-0 text-text-secondary shadow-none transition-colors hover:translate-y-0 hover:scale-100 hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-30'
                                title='Move up'
                                aria-label={`Move ${titleText || 'song'} up`}
                              >
                                <ChevronUp size={13} />
                              </Button>
                              <Button
                                type='button'
                                onClick={() => reorderItems(index, index + 1)}
                                disabled={index === sequence.items.length - 1}
                                className='flex h-6 w-6 pointer-coarse:h-11 pointer-coarse:w-8 items-center justify-center rounded border-0 bg-transparent p-0 text-text-secondary shadow-none transition-colors hover:translate-y-0 hover:scale-100 hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-30'
                                title='Move down'
                                aria-label={`Move ${titleText || 'song'} down`}
                              >
                                <ChevronDown size={13} />
                              </Button>
                              {onQueueItem ? (
                                <Button
                                  type='button'
                                  onClick={() => void onQueueItem(displayItem.id)}
                                  className='flex h-6 w-6 pointer-coarse:h-11 pointer-coarse:w-8 items-center justify-center rounded border-0 bg-transparent p-0 text-text-secondary shadow-none transition-colors hover:translate-y-0 hover:scale-100 hover:text-sea'
                                  title='Play next'
                                  aria-label={`Play ${titleText || 'song'} next`}
                                >
                                  <ListPlus size={13} />
                                </Button>
                              ) : null}
                              <Button
                                type='button'
                                onClick={() => setExpandedItemId((prev) => (prev === displayItem.id ? null : displayItem.id))}
                                className='flex h-6 w-6 pointer-coarse:h-11 pointer-coarse:w-8 items-center justify-center rounded border-0 bg-transparent p-0 text-text-secondary shadow-none transition-colors hover:translate-y-0 hover:scale-100 hover:text-text-primary'
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
                              <Button
                                type='button'
                                onClick={() => removeItem(index)}
                                className='flex h-6 w-6 pointer-coarse:h-11 pointer-coarse:w-8 items-center justify-center rounded border-0 bg-transparent p-0 text-text-secondary shadow-none transition-colors hover:translate-y-0 hover:scale-100 hover:text-terracotta'
                                title='Remove'
                                aria-label={`Remove ${displayItem.title?.trim() || 'song'}`}
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
                          {isExpanded ? (
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
            // Beside the playlist from 768 px; below it on a phone, where it was hidden and Add fillers added nothing
            // (walk part 4).
            className={`flex min-h-0 flex-col border-t border-sand/30 bg-dark-sand/70 ${showQueue ? 'w-full md:w-[320px] md:shrink-0' : 'min-h-0 flex-1'}`}
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
            <div className={showQueue ? 'max-h-80 overflow-y-auto md:max-h-none md:min-h-0 md:flex-1' : 'max-h-125 overflow-y-auto'}>
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
                    {/* Always visible: a touch screen has no hover (walk part 4). A song already in the playlist shows a
                        muted check, never Bleecker's filled disabled button, so the addable ones read as the actions. */}
                    <Button
                      type='button'
                      disabled={songIdsInPlaylist.has(song.id)}
                      onClick={() => addItemFromCatalog(song)}
                      className='flex h-6 w-6 shrink-0 pointer-coarse:h-11 pointer-coarse:w-8 items-center justify-center rounded-full border-0 bg-transparent p-0 text-text-secondary shadow-none transition-all hover:translate-y-0 hover:scale-100 hover:bg-sea/20 hover:text-sea disabled:bg-transparent disabled:text-text-secondary disabled:opacity-60'
                      title={songIdsInPlaylist.has(song.id) ? 'Already in the playlist' : `Add ${song.title || 'song'} to the playlist`}
                      aria-label={songIdsInPlaylist.has(song.id) ? 'Already in the playlist' : `Add ${song.title || 'song'} to the playlist`}
                    >
                      {songIdsInPlaylist.has(song.id) ? <Check size={14} aria-hidden='true' /> : <Plus size={14} aria-hidden='true' />}
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
