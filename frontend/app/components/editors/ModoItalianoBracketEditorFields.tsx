import React, { useMemo } from 'react';
import { Input, Select } from '@gaulatti/bleecker';
import type { SongCatalogItem } from '../../models/broadcast';
import {
  applyModoItalianoBracketAdvancement,
  normalizeModoItalianoBracketMatches,
  type ModoItalianoBracketMatch
} from '../../utils/modoItalianoBracket';

export function ModoItalianoBracketEditorFields({
  props,
  updateProp,
  componentType,
  songCatalog
}: {
  props: { title?: string; show?: boolean; matches?: ModoItalianoBracketMatch[] };
  updateProp: (componentType: string, propName: string, value: any) => void;
  componentType: string;
  songCatalog: SongCatalogItem[];
}) {
  const songLabelById = useMemo(() => {
    const labels = new Map<number, string>();
    songCatalog.forEach((song) => labels.set(song.id, `${song.artist} - ${song.title}`));
    return labels;
  }, [songCatalog]);

  const safeMatches = useMemo(() => normalizeModoItalianoBracketMatches(props.matches), [props.matches]);

  const updateMatch = (matchId: number, field: keyof ModoItalianoBracketMatch, value: any) => {
    if ((field === 'songAId' || field === 'songBId') && matchId > 8) {
      return;
    }

    const newMatches = [...safeMatches];
    const index = matchId - 1;

    if ((field === 'songAId' || field === 'songBId') && typeof value === 'number') {
      const songAlreadySelected = newMatches.slice(0, 8).some((match) => {
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

    updateProp(componentType, 'matches', applyModoItalianoBracketAdvancement(newMatches));
  };

  const getSongOptionsForSlot = (matchId: number, field: 'songAId' | 'songBId') => {
    const currentValue = safeMatches[matchId - 1]?.[field] ?? null;
    const selectedSongIds = new Set<number>();

    safeMatches.slice(0, 8).forEach((match) => {
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
      </div>

      <div className='space-y-4'>
        <h3 className='text-sm font-bold text-text-primary uppercase tracking-wide border-b border-[#3A3A3A] pb-2'>Matches Configuration</h3>

        {safeMatches.map((match) => {
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
                {match.id <= 8 ? (
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
                {match.id <= 8 ? (
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
