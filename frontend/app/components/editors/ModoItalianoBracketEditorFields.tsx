import React, { useMemo, useState } from 'react';
import { Button, Input, Select } from '@gaulatti/bleecker';
import type { SongCatalogItem } from '../../models/broadcast';
import { apiUrl } from '../../utils/apiBaseUrl';
import {
  applyModoItalianoBracketAdvancement,
  createDefaultModoItalianoBracketMatches,
  drawModoItalianoBracketOpeningSongs,
  getModoItalianoBracketOpeningMatchIds,
  normalizeModoItalianoBracketDrawDurationSeconds,
  normalizeModoItalianoBracketDrawSeed,
  normalizeModoItalianoBracketMatches,
  normalizeModoItalianoBracketStartRound,
  normalizeModoItalianoBracketSongPoolIds,
  type ModoItalianoBracketDrawCommand,
  type ModoItalianoBracketMatch,
  type ModoItalianoBracketStartRound
} from '../../utils/modoItalianoBracket';

export function ModoItalianoBracketEditorFields({
  props,
  updateProp,
  replaceProps,
  commitProps,
  componentType,
  songCatalog,
  sceneId
}: {
  props: {
    title?: string;
    show?: boolean;
    startRound?: ModoItalianoBracketStartRound;
    matches?: ModoItalianoBracketMatch[];
    randomSongPoolIds?: number[];
    drawSeed?: number;
    drawDurationSeconds?: number;
    drawCommand?: ModoItalianoBracketDrawCommand | null;
  };
  updateProp: (componentType: string, propName: string, value: any) => void;
  replaceProps?: (componentType: string, nextProps: any) => void;
  commitProps?: (componentType: string, nextProps: any) => Promise<void> | void;
  componentType: string;
  songCatalog: SongCatalogItem[];
  sceneId?: number;
}) {
  const [songSearch, setSongSearch] = useState('');
  const [isDrawPending, setIsDrawPending] = useState(false);

  const songLabelById = useMemo(() => {
    const labels = new Map<number, string>();
    songCatalog.forEach((song) => labels.set(song.id, `${song.artist} - ${song.title}`));
    return labels;
  }, [songCatalog]);

  const songCatalogIds = useMemo(() => new Set(songCatalog.map((song) => song.id)), [songCatalog]);
  const startRound = normalizeModoItalianoBracketStartRound(props.startRound);
  const openingMatchIds = useMemo(() => getModoItalianoBracketOpeningMatchIds(startRound), [startRound]);
  const openingMatchIdSet = useMemo(() => new Set(openingMatchIds), [openingMatchIds]);
  const visibleMatchIds = startRound === 'quarterfinals' ? [9, 10, 11, 12, 13, 14, 15] : [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
  const drawSeed = normalizeModoItalianoBracketDrawSeed(props.drawSeed);
  const drawDurationSeconds = normalizeModoItalianoBracketDrawDurationSeconds(props.drawDurationSeconds, drawSeed);
  const randomSongPoolIds = useMemo(
    () => normalizeModoItalianoBracketSongPoolIds(props.randomSongPoolIds, songCatalogIds),
    [props.randomSongPoolIds, songCatalogIds]
  );
  const randomSongPoolSet = useMemo(() => new Set(randomSongPoolIds), [randomSongPoolIds]);
  const safeMatches = useMemo(() => normalizeModoItalianoBracketMatches(props.matches, startRound), [props.matches, startRound]);

  const selectedRandomSongs = useMemo(
    () => randomSongPoolIds.map((songId) => songCatalog.find((song) => song.id === songId)).filter((song): song is SongCatalogItem => Boolean(song)),
    [randomSongPoolIds, songCatalog]
  );

  const searchableSongs = useMemo(() => {
    const search = songSearch.trim().toLowerCase();
    return songCatalog
      .filter((song) => !randomSongPoolSet.has(song.id))
      .filter((song) => {
        if (!search) {
          return true;
        }
        return `${song.artist} ${song.title}`.toLowerCase().includes(search);
      })
      .sort((a, b) => `${a.artist} ${a.title}`.localeCompare(`${b.artist} ${b.title}`))
      .slice(0, 12);
  }, [randomSongPoolSet, songCatalog, songSearch]);

  const applyComponentProps = (nextProps: typeof props) => {
    if (commitProps) {
      void commitProps(componentType, nextProps);
      return;
    }
    if (replaceProps) {
      replaceProps(componentType, nextProps);
      return;
    }
    Object.entries(nextProps).forEach(([propName, value]) => updateProp(componentType, propName, value));
  };

  const resetMatches = () => {
    setIsDrawPending(false);
    applyComponentProps({
      ...props,
      matches: createDefaultModoItalianoBracketMatches(),
      drawCommand: null
    });
  };

  const updateDrawSeed = (value: unknown) => {
    const nextSeed = normalizeModoItalianoBracketDrawSeed(value);
    const nextProps = {
      ...props,
      drawSeed: nextSeed,
      drawDurationSeconds: nextSeed
    };

    if (replaceProps) {
      replaceProps(componentType, nextProps);
      return;
    }
    updateProp(componentType, 'drawSeed', nextSeed);
    updateProp(componentType, 'drawDurationSeconds', nextSeed);
  };

  const drawPreview = useMemo(
    () => drawModoItalianoBracketOpeningSongs(safeMatches, startRound, randomSongPoolIds, drawSeed),
    [drawSeed, randomSongPoolIds, safeMatches, startRound]
  );
  const canDrawFromPool =
    !isDrawPending &&
    startRound === 'quarterfinals' &&
    drawPreview.emptySlotCount > 0 &&
    drawPreview.availableSongCount > 0 &&
    drawPreview.drawnSongIds.length === 1;

  const drawFromPool = () => {
    if (!canDrawFromPool) {
      return;
    }

    const now = Date.now();
    const effectiveSeed = drawSeed + now;
    const drawResult = drawModoItalianoBracketOpeningSongs(safeMatches, startRound, randomSongPoolIds, effectiveSeed);
    if (drawResult.drawnSongIds.length !== 1) {
      return;
    }

    if (!sceneId) return;
    setIsDrawPending(true);
    void fetch(apiUrl(`/scenes/${sceneId}/modo-italiano-bracket/draw`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ componentType, seed: effectiveSeed })
    })
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
      })
      .catch((error) => console.error('Failed to start Modo Italiano bracket draw:', error))
      .finally(() => window.setTimeout(() => setIsDrawPending(false), drawDurationSeconds * 1000));
  };

  const addRandomSongPoolId = (songId: number) => {
    updateProp(componentType, 'randomSongPoolIds', normalizeModoItalianoBracketSongPoolIds([...randomSongPoolIds, songId], songCatalogIds));
  };

  const removeRandomSongPoolId = (songId: number) => {
    updateProp(
      componentType,
      'randomSongPoolIds',
      normalizeModoItalianoBracketSongPoolIds(
        randomSongPoolIds.filter((id) => id !== songId),
        songCatalogIds
      )
    );
  };

  const updateMatch = (matchId: number, field: keyof ModoItalianoBracketMatch, value: any) => {
    if ((field === 'songAId' || field === 'songBId') && !openingMatchIdSet.has(matchId)) {
      return;
    }

    const newMatches = [...safeMatches];
    const index = matchId - 1;

    if ((field === 'songAId' || field === 'songBId') && typeof value === 'number') {
      const songAlreadySelected = newMatches.some((match) => {
        if (!openingMatchIdSet.has(match.id)) {
          return false;
        }

        if (match.id === matchId) {
          return (field !== 'songAId' && match.songAId === value) || (field !== 'songBId' && match.songBId === value);
        }

        return match.songAId === value || match.songBId === value;
      });

      if (songAlreadySelected) {
        return;
      }
    }

    newMatches[index] = { ...newMatches[index], [field]: value };

    updateProp(componentType, 'matches', applyModoItalianoBracketAdvancement(newMatches, startRound));
  };

  const getSongOptionsForSlot = (matchId: number, field: 'songAId' | 'songBId') => {
    const currentValue = safeMatches[matchId - 1]?.[field] ?? null;
    const selectedSongIds = new Set<number>();

    safeMatches.forEach((match) => {
      if (!openingMatchIdSet.has(match.id)) {
        return;
      }

      if (!(match.id === matchId && field === 'songAId') && match.songAId !== null) {
        selectedSongIds.add(match.songAId);
      }
      if (!(match.id === matchId && field === 'songBId') && match.songBId !== null) {
        selectedSongIds.add(match.songBId);
      }
    });

    return [
      { value: '', label: '-- Select Song --' },
      ...songCatalog
        .filter((song) => song.id === currentValue || !selectedSongIds.has(song.id))
        .map((song) => ({ value: String(song.id), label: `${song.artist} - ${song.title}` }))
    ];
  };

  const getSongLabel = (songId: number | null) => (songId === null ? 'Waiting for winner' : (songLabelById.get(songId) ?? `Song #${songId}`));

  const getMatchLabel = (id: number) => {
    if (id <= 8) return `Round of 16 - Match ${id}`;
    if (id <= 12) return `Quarter Final - Match ${id - 8}`;
    if (id <= 14) return `Semi Final - Match ${id - 12}`;
    return `Grand Final`;
  };

  return (
    <div className='space-y-6'>
      <div className='space-y-3 bg-[#1D1D1B] p-4 rounded-lg border border-[#3A3A3A]'>
        <div>
          <label className='block text-xs text-text-secondary mb-1'>Bracket Title</label>
          <Input
            type='text'
            value={props.title || ''}
            onChange={(e) => updateProp(componentType, 'title', e.target.value)}
            className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-sea/50'
            placeholder='TORNEO CANCIÓN'
          />
        </div>
        <label className='flex items-center gap-2 text-sm text-text-primary'>
          <Input
            type='checkbox'
            checked={typeof props.show === 'boolean' ? props.show : true}
            onChange={(e) => updateProp(componentType, 'show', e.target.checked)}
            className='h-4 w-4'
          />
          Show Bracket Overlay
        </label>
        <div>
          <label className='block text-xs text-text-secondary mb-1'>Starting Round</label>
          <Select
            value={startRound}
            onChange={(value) => updateProp(componentType, 'startRound', normalizeModoItalianoBracketStartRound(value))}
            className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-sea/50'
            options={[
              { value: 'roundOf16', label: 'Round of 16' },
              { value: 'quarterfinals', label: 'Quarterfinals' }
            ]}
          />
        </div>
      </div>

      <div className='space-y-3 bg-[#1D1D1B] p-4 rounded-lg border border-[#3A3A3A]'>
        <div className='flex flex-wrap items-center justify-between gap-2'>
          <div>
            <h3 className='text-sm font-bold text-text-primary uppercase tracking-wide'>Random Song Pool</h3>
            <p className='mt-1 text-xs text-text-secondary'>Select songs that will be eligible for random bracket picks.</p>
          </div>
          <div className='flex flex-wrap gap-2'>
            {randomSongPoolIds.length > 0 && (
              <Button
                type='button'
                onClick={() => updateProp(componentType, 'randomSongPoolIds', [])}
                className='px-3 py-1.5 text-xs font-semibold rounded border border-terracotta/35 text-terracotta hover:bg-terracotta/10'
              >
                Clear Pool
              </Button>
            )}
            <Button
              type='button'
              onClick={drawFromPool}
              disabled={!canDrawFromPool}
              className='px-3 py-1.5 text-xs font-semibold rounded border border-sea/40 text-sea hover:bg-sea/10 disabled:cursor-not-allowed disabled:opacity-40'
            >
              {isDrawPending ? 'Drawing…' : 'Draw Pool'}
            </Button>
          </div>
        </div>

        <div className='grid grid-cols-1 gap-3 sm:grid-cols-2'>
          <label className='text-sm text-text-primary'>
            <span className='block text-xs text-text-secondary mb-1'>Draw Seed</span>
            <Input
              type='number'
              min={1}
              step={1}
              value={drawSeed}
              onChange={(e) => updateDrawSeed(e.target.value)}
              className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-sea/50'
            />
          </label>
          <label className='text-sm text-text-primary'>
            <span className='block text-xs text-text-secondary mb-1'>Draw Seconds</span>
            <Input
              type='number'
              min={1}
              step={1}
              value={drawDurationSeconds}
              onChange={(e) => updateProp(componentType, 'drawDurationSeconds', normalizeModoItalianoBracketDrawDurationSeconds(e.target.value, drawSeed))}
              className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-sea/50'
            />
          </label>
        </div>
        {startRound !== 'quarterfinals' && <p className='text-xs text-text-secondary italic'>Draw Pool is available when the bracket starts at Quarterfinals.</p>}
        {startRound === 'quarterfinals' && drawPreview.emptySlotCount > 0 && drawPreview.availableSongCount === 0 && (
          <p className='text-xs text-terracotta'>Add unused songs to the pool before drawing.</p>
        )}

        <Input
          type='search'
          value={songSearch}
          onChange={(e) => setSongSearch(e.target.value)}
          className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-sea/50'
          placeholder='Search songs by artist or title'
        />

        <div className='space-y-2'>
          <p className='text-[10px] text-text-secondary uppercase tracking-wide'>Selected ({selectedRandomSongs.length})</p>
          {selectedRandomSongs.length === 0 ? (
            <p className='text-xs text-text-secondary italic'>No songs selected for random picks yet.</p>
          ) : (
            <div className='space-y-1.5'>
              {selectedRandomSongs.map((song) => (
                <div key={song.id} className='flex items-center justify-between gap-2 rounded border border-[#3A3A3A] bg-[#2B2B2B] px-2 py-1.5'>
                  <span className='min-w-0 truncate text-xs text-text-primary'>{`${song.artist} - ${song.title}`}</span>
                  <Button
                    type='button'
                    onClick={() => removeRandomSongPoolId(song.id)}
                    className='shrink-0 px-2 py-1 text-[10px] font-semibold rounded border border-terracotta/35 text-terracotta hover:bg-terracotta/10'
                  >
                    Remove
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className='space-y-2'>
          <p className='text-[10px] text-text-secondary uppercase tracking-wide'>Songs</p>
          {searchableSongs.length === 0 ? (
            <p className='text-xs text-text-secondary italic'>{songSearch.trim() ? 'No matching songs.' : 'No more songs available.'}</p>
          ) : (
            <div className='space-y-1.5'>
              {searchableSongs.map((song) => (
                <div key={song.id} className='flex items-center justify-between gap-2 rounded border border-[#3A3A3A] bg-[rgba(255,255,255,0.03)] px-2 py-1.5'>
                  <div className='min-w-0'>
                    <p className='truncate text-xs text-text-primary'>{`${song.artist} - ${song.title}`}</p>
                    {!song.enabled && <p className='text-[10px] text-text-secondary'>Disabled</p>}
                  </div>
                  <Button
                    type='button'
                    onClick={() => addRandomSongPoolId(song.id)}
                    className='shrink-0 px-2 py-1 text-[10px] font-semibold rounded border border-sea/40 text-sea hover:bg-sea/10'
                  >
                    Add
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className='space-y-4'>
        <div className='flex items-center justify-between gap-3 border-b border-[#3A3A3A] pb-2'>
          <h3 className='text-sm font-bold text-text-primary uppercase tracking-wide'>Matches Configuration</h3>
          <Button
            type='button'
            onClick={resetMatches}
            className='px-3 py-1.5 text-xs font-semibold rounded border border-terracotta/50 text-terracotta hover:bg-terracotta/10'
          >
            Reset Bracket
          </Button>
        </div>

        {visibleMatchIds.map((matchId) => {
          const match = safeMatches[matchId - 1];
          const songA = songCatalog.find((s) => s.id === match.songAId);
          const songB = songCatalog.find((s) => s.id === match.songBId);

          const winnerOptions = [{ value: '', label: '-- Undecided --' }];
          if (songA) winnerOptions.push({ value: String(songA.id), label: `${songA.artist} - ${songA.title}` });
          if (songB) winnerOptions.push({ value: String(songB.id), label: `${songB.artist} - ${songB.title}` });

          return (
            <div key={match.id} className='bg-[rgba(255,255,255,0.03)] border border-[#3A3A3A] p-3 rounded space-y-3'>
              <h4 className='text-xs font-bold text-[#e2a842] uppercase'>{getMatchLabel(match.id)}</h4>

              <div>
                <label className='block text-[10px] text-text-secondary mb-1 uppercase'>Song A</label>
                {openingMatchIdSet.has(match.id) ? (
                  <Select
                    value={match.songAId ? String(match.songAId) : ''}
                    onChange={(val) => updateMatch(match.id, 'songAId', val ? parseInt(val, 10) : null)}
                    options={getSongOptionsForSlot(match.id, 'songAId')}
                    className='w-full px-2 py-1.5 text-xs'
                  />
                ) : (
                  <div className='px-2 py-1.5 text-xs text-text-primary bg-[#2B2B2B] rounded border border-[#3A3A3A] truncate'>{getSongLabel(match.songAId)}</div>
                )}
              </div>

              <div>
                <label className='block text-[10px] text-text-secondary mb-1 uppercase'>Song B</label>
                {openingMatchIdSet.has(match.id) ? (
                  <Select
                    value={match.songBId ? String(match.songBId) : ''}
                    onChange={(val) => updateMatch(match.id, 'songBId', val ? parseInt(val, 10) : null)}
                    options={getSongOptionsForSlot(match.id, 'songBId')}
                    className='w-full px-2 py-1.5 text-xs'
                  />
                ) : (
                  <div className='px-2 py-1.5 text-xs text-text-primary bg-[#2B2B2B] rounded border border-[#3A3A3A] truncate'>{getSongLabel(match.songBId)}</div>
                )}
              </div>

              <div>
                <label className='block text-[10px] text-text-secondary mb-1 uppercase'>Winner</label>
                <Select
                  value={match.winnerId ? String(match.winnerId) : ''}
                  onChange={(val) => updateMatch(match.id, 'winnerId', val ? parseInt(val, 10) : null)}
                  options={winnerOptions}
                  className='w-full px-2 py-1.5 text-xs bg-[#2B2B2B] font-bold text-white'
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
