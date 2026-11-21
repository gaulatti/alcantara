import { describe, expect, it } from 'vitest';
import {
  applyModoItalianoBracketAdvancement,
  createDefaultModoItalianoBracketMatches,
  drawModoItalianoBracketOpeningSongs,
  fillNextModoItalianoBracketOpeningSlot,
  normalizeModoItalianoBracketDrawCommand,
  normalizeModoItalianoBracketMatches,
  normalizeModoItalianoBracketSongPoolIds
} from './modoItalianoBracket';

describe('bracket song pool', () => {
  it('keeps positive integer ids once, from numbers or strings, limited to the catalogue', () => {
    expect(normalizeModoItalianoBracketSongPoolIds('1,2')).toEqual([]);
    expect(normalizeModoItalianoBracketSongPoolIds([1, '2', 2, 0, -1, 1.5, 'x', null])).toEqual([1, 2]);
    expect(normalizeModoItalianoBracketSongPoolIds([1, 2, 3], new Set([2, 3]))).toEqual([2, 3]);
  });
});

describe('bracket draw command', () => {
  it('rejects anything without a numeric id and start time', () => {
    expect(normalizeModoItalianoBracketDrawCommand(null)).toBeNull();
    expect(normalizeModoItalianoBracketDrawCommand([])).toBeNull();
    expect(normalizeModoItalianoBracketDrawCommand({ id: '1', startedAt: 0 })).toBeNull();
    expect(normalizeModoItalianoBracketDrawCommand({ id: 1 })).toBeNull();
  });

  it('normalises the seed, duration, pool and selected song', () => {
    expect(
      normalizeModoItalianoBracketDrawCommand({ id: 1, startedAt: 10, seed: '7.9', durationSeconds: '3.5', songIds: [4, '5'], selectedSongId: 5 })
    ).toEqual({ id: 1, seed: 7, startedAt: 10, durationSeconds: 3, songIds: [4, 5], selectedSongId: 5 });
    expect(normalizeModoItalianoBracketDrawCommand({ id: 2, startedAt: 0, seed: -1, durationSeconds: 'x' })).toEqual({
      id: 2,
      seed: 5,
      startedAt: 0,
      durationSeconds: 5,
      songIds: [],
      selectedSongId: null
    });
  });
});

describe('bracket match normalization', () => {
  it('ignores malformed matches and out-of-range ids, and clears non-numeric fields', () => {
    const matches = normalizeModoItalianoBracketMatches([
      null,
      'x',
      { id: 0, songAId: 1 },
      { id: 16, songAId: 1 },
      { id: '1', songAId: 1 },
      { id: 1, songAId: 3, songBId: '4', winnerId: 'x' }
    ]);
    expect(matches[0]).toEqual({ id: 1, songAId: 3, songBId: null, winnerId: null });
    expect(matches).toHaveLength(15);
  });

  it('drops repeated opening songs and winners that are not in their match, and advances winners', () => {
    const matches = createDefaultModoItalianoBracketMatches();
    matches[0] = { id: 1, songAId: 1, songBId: 2, winnerId: 2 };
    matches[1] = { id: 2, songAId: 1, songBId: 2, winnerId: 9 };
    const advanced = applyModoItalianoBracketAdvancement(matches);
    expect(advanced[1]).toEqual({ id: 2, songAId: null, songBId: null, winnerId: null });
    expect(advanced[8]).toMatchObject({ id: 9, songAId: 2, songBId: null });
  });

  it('starts at the quarterfinals, ignoring round-of-16 matches', () => {
    const matches = createDefaultModoItalianoBracketMatches();
    matches[0] = { id: 1, songAId: 1, songBId: 2, winnerId: 1 };
    matches[8] = { id: 9, songAId: 3, songBId: 4, winnerId: 4 };
    const advanced = applyModoItalianoBracketAdvancement(matches, 'quarterfinals');
    expect(advanced[8]).toMatchObject({ songAId: 3, songBId: 4 });
    expect(advanced[12]).toMatchObject({ id: 13, songAId: 4 });
  });
});

describe('bracket opening draw', () => {
  it('draws one unused song into the first empty slot', () => {
    const matches = createDefaultModoItalianoBracketMatches();
    matches[0] = { id: 1, songAId: 1, songBId: null, winnerId: null };
    const result = drawModoItalianoBracketOpeningSongs(matches, 'roundOf16', [1, 2], 3);
    expect(result).toMatchObject({ drawnSongIds: [2], availableSongIds: [2], emptySlotCount: 15, availableSongCount: 1 });
    expect(result.matches[0]).toMatchObject({ songAId: 1, songBId: 2 });
  });

  it('draws nothing when every opening slot is filled', () => {
    const matches = createDefaultModoItalianoBracketMatches();
    [9, 10, 11, 12].forEach((id, index) => {
      matches[id - 1] = { id, songAId: index * 2 + 1, songBId: index * 2 + 2, winnerId: null };
    });
    const result = drawModoItalianoBracketOpeningSongs(matches, 'quarterfinals', [20, 21], 'seed');
    expect(result).toMatchObject({ drawnSongIds: [], emptySlotCount: 0, availableSongCount: 2 });
  });
});

describe('filling the next opening slot', () => {
  it('ignores an invalid or already used song and a full bracket, and fills the first empty slot otherwise', () => {
    const matches = createDefaultModoItalianoBracketMatches();
    matches[8] = { id: 9, songAId: 1, songBId: null, winnerId: null };
    expect(fillNextModoItalianoBracketOpeningSlot(matches, 'quarterfinals', 'x')[8].songBId).toBeNull();
    expect(fillNextModoItalianoBracketOpeningSlot(matches, 'quarterfinals', 1)[8].songBId).toBeNull();
    expect(fillNextModoItalianoBracketOpeningSlot(matches, 'quarterfinals', '2')[8].songBId).toBe(2);

    const full = createDefaultModoItalianoBracketMatches();
    [9, 10, 11, 12].forEach((id, index) => {
      full[id - 1] = { id, songAId: index * 2 + 1, songBId: index * 2 + 2, winnerId: null };
    });
    expect(fillNextModoItalianoBracketOpeningSlot(full, 'quarterfinals', 30)).toEqual(normalizeModoItalianoBracketMatches(full, 'quarterfinals'));
  });
});
