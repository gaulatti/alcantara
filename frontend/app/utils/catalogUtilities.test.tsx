import { afterEach, describe, expect, it, vi } from 'vitest';
import { getSupportedTimezones, getTimezoneOptionLabel, getTimezonesSortedByOffset } from './timezones';
import {
  buildEaroneRealtimeLookup, matchEaroneRealtimeEntry, normalizeEaroneMatchKey,
} from './earoneRealtime';
import {
  applyModoItalianoBracketAdvancement, createDefaultModoItalianoBracketMatches,
  drawModoItalianoBracketOpeningSongs, fillNextModoItalianoBracketOpeningSlot,
  getModoItalianoBracketOpeningMatchIds, normalizeModoItalianoBracketDrawCommand,
  normalizeModoItalianoBracketDrawDurationSeconds, normalizeModoItalianoBracketDrawSeed,
  normalizeModoItalianoBracketMatches, normalizeModoItalianoBracketSongPoolIds,
  normalizeModoItalianoBracketStartRound,
} from './modoItalianoBracket';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('timezone choices', () => {
  const date = new Date('2026-01-15T12:00:00Z');
  it('uses browser timezone choices when the runtime supplies them', () => {
    vi.spyOn(Intl, 'supportedValuesOf').mockReturnValue(['UTC', 'Europe/Paris']);
    expect(getSupportedTimezones()).toEqual(['UTC', 'Europe/Paris']);
    expect(getTimezoneOptionLabel('America/New_York', date)).toBe('New York (GMT-5)');
    expect(getTimezoneOptionLabel('UTC', date)).toBe('UTC (GMT)');
    expect(getTimezoneOptionLabel('invalid-zone', date)).toBe('invalid-zone (GMT)');
  });
  it('orders negative, zero, half-hour and positive offsets chronologically', () => {
    vi.spyOn(Intl, 'supportedValuesOf').mockReturnValue([
      'Europe/Paris', 'Asia/Kolkata', 'UTC', 'America/New_York', 'Europe/London',
    ]);
    expect(getTimezonesSortedByOffset(date)).toEqual([
      'America/New_York', 'Europe/London', 'UTC', 'Europe/Paris', 'Asia/Kolkata',
    ]);
  });
  it('uses the existing fallback list for empty, missing, or unavailable runtime support', () => {
    const supported = vi.spyOn(Intl, 'supportedValuesOf').mockReturnValue([]);
    expect(getSupportedTimezones()).toContain('UTC');
    expect(getSupportedTimezones()).toContain('America/New_York');
    supported.mockImplementation(() => { throw new RangeError('not supported'); });
    expect(getSupportedTimezones()).toContain('Australia/Sydney');
    vi.stubGlobal('Intl', { DateTimeFormat: Intl.DateTimeFormat });
    expect(getSupportedTimezones()).toContain('Europe/Paris');
  });
  it('handles unavailable offset names without preventing timezone selection', () => {
    vi.spyOn(Intl, 'supportedValuesOf').mockReturnValue(['Unknown', 'UTC']);
    vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(() => ({
      formatToParts: () => [{ type: 'hour', value: '12' }],
    }) as Intl.DateTimeFormat);
    expect(getTimezoneOptionLabel('Unknown', date)).toBe('Unknown (GMT)');
    expect(getTimezonesSortedByOffset(date)).toEqual(['Unknown', 'UTC']);
  });
});

describe('live chart identity matching', () => {
  const first = {
    earoneSongId: '42', artist: 'Måneskin', title: 'Zitti & Buoni', normalizedKey: 'maneskin zitti and buoni',
    ranking: '1', radioSpinsToday: '200', spotifyPlays: null, youtubeViews: null, youtubeLikes: null,
  };
  it('normalizes accents and punctuation without discarding words or numbers', () => {
    expect(normalizeEaroneMatchKey('  MÅNESKIN: Zitti & Buoni 2026!  ')).toBe('maneskin zitti and buoni 2026');
  });
  it('prefers an explicit song identity and otherwise matches normalized text', () => {
    const duplicate = { ...first, earoneSongId: '43', ranking: '2' };
    const lookup = buildEaroneRealtimeLookup({
      entries: [null, 'bad', {}, { ...first, artist: '' }, { ...first, title: '' }, first, duplicate,
        { ...first, earoneSongId: null, normalizedKey: 'another song' }],
      updatedAt: '2026-10-24T12:00:00Z',
      sources: { earoneUpdatedAt: '2026-10-24T11:59:00Z', escplusUpdatedAt: 0 },
    });
    expect(lookup.updatedAt).toBe('2026-10-24T12:00:00Z');
    expect(lookup.sources).toEqual({ earoneUpdatedAt: '2026-10-24T11:59:00Z', escplusUpdatedAt: null });
    expect(matchEaroneRealtimeEntry(lookup, { earoneSongId: ' 43 ', text: first.normalizedKey })).toEqual(duplicate);
    expect(matchEaroneRealtimeEntry(lookup, { earoneSongId: 'missing', text: 'Måneskin: Zitti & Buoni' })).toEqual(first);
    expect(matchEaroneRealtimeEntry(lookup, { text: 'another song' })).toMatchObject({ earoneSongId: null });
    expect(matchEaroneRealtimeEntry(lookup, { text: 'missing' })).toBeNull();
    expect(matchEaroneRealtimeEntry(lookup, { earoneSongId: ' ', text: ' ' })).toBeNull();
    expect(matchEaroneRealtimeEntry(null, { earoneSongId: '42' })).toBeNull();
  });
  it('preserves an empty lookup for unavailable or malformed chart payloads', () => {
    expect(buildEaroneRealtimeLookup(null)).toEqual({ bySongId: {}, byNormalizedText: {}, updatedAt: null, sources: undefined });
    expect(buildEaroneRealtimeLookup({ entries: 'bad', sources: {} }).sources)
      .toEqual({ earoneUpdatedAt: null, escplusUpdatedAt: null });
    expect(buildEaroneRealtimeLookup({ sources: { escplusUpdatedAt: 'now' } }).sources)
      .toEqual({ earoneUpdatedAt: null, escplusUpdatedAt: 'now' });
  });
});

describe('song bracket draws', () => {
  it('keeps only valid catalog identities and normalizes operator draw settings', () => {
    expect(normalizeModoItalianoBracketSongPoolIds([1, '2', 1, -1, 0, 1.5, {}, 'bad', 3], new Set([1, 2])))
      .toEqual([1, 2]);
    expect(normalizeModoItalianoBracketSongPoolIds(null)).toEqual([]);
    expect(normalizeModoItalianoBracketSongPoolIds([3, 2, 3])).toEqual([3, 2]);
    expect(normalizeModoItalianoBracketStartRound('quarterfinals')).toBe('quarterfinals');
    expect(normalizeModoItalianoBracketStartRound('invalid')).toBe('roundOf16');
    expect(getModoItalianoBracketOpeningMatchIds('quarterfinals')).toEqual([9, 10, 11, 12]);
    expect(getModoItalianoBracketOpeningMatchIds(null)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(normalizeModoItalianoBracketDrawSeed('12.9')).toBe(12);
    expect(normalizeModoItalianoBracketDrawSeed(-1)).toBe(5);
    expect(normalizeModoItalianoBracketDrawSeed(null)).toBe(5);
    expect(normalizeModoItalianoBracketDrawDurationSeconds('0.2')).toBe(1);
    expect(normalizeModoItalianoBracketDrawDurationSeconds(8.9)).toBe(8);
    expect(normalizeModoItalianoBracketDrawDurationSeconds(null, 7)).toBe(7);
  });
  it('rejects malformed commands and supplies a bounded normalized command', () => {
    for (const value of [null, [], false, {}, { id: '1', startedAt: 100 }, { id: 1, startedAt: '100' }]) {
      expect(normalizeModoItalianoBracketDrawCommand(value)).toBeNull();
    }
    expect(normalizeModoItalianoBracketDrawCommand({ id: 1, startedAt: 100, seed: 7, songIds: [1, '2'], selectedSongId: 2 }))
      .toEqual({ id: 1, startedAt: 100, seed: 7, durationSeconds: 7, songIds: [1, 2], selectedSongId: 2 });
    expect(normalizeModoItalianoBracketDrawCommand({ id: 2, startedAt: 100 })).toMatchObject({
      seed: 5, durationSeconds: 5, songIds: [], selectedSongId: null,
    });
  });
  it('draws one previously unused song deterministically and leaves its inputs unchanged', () => {
    const matches = createDefaultModoItalianoBracketMatches();
    matches[0].songAId = 1;
    const before = structuredClone(matches);
    const first = drawModoItalianoBracketOpeningSongs(matches, 'roundOf16', [1, 2, 3, 4], 17);
    expect(first).toEqual(drawModoItalianoBracketOpeningSongs(matches, 'roundOf16', [1, 2, 3, 4], 17));
    expect(first.drawnSongIds).toHaveLength(1);
    expect(first.drawnSongIds[0]).not.toBe(1);
    expect(first.matches[0]).toMatchObject({ songAId: 1, songBId: first.drawnSongIds[0] });
    expect(first.availableSongIds).not.toContain(1);
    expect(first.emptySlotCount).toBe(15);
    expect(first.availableSongCount).toBe(3);
    expect(matches).toEqual(before);
  });
  it('does not duplicate a selected song, fill a full bracket, or accept an invalid selection', () => {
    let matches = createDefaultModoItalianoBracketMatches();
    matches = fillNextModoItalianoBracketOpeningSlot(matches, 'quarterfinals', 1);
    expect(matches[8]).toMatchObject({ songAId: 1, songBId: null });
    expect(fillNextModoItalianoBracketOpeningSlot(matches, 'quarterfinals', 1)).toEqual(matches);
    expect(fillNextModoItalianoBracketOpeningSlot(matches, 'quarterfinals', 'bad')).toEqual(matches);
    for (let song = 2; song <= 8; song += 1) matches = fillNextModoItalianoBracketOpeningSlot(matches, 'quarterfinals', song);
    expect(fillNextModoItalianoBracketOpeningSlot(matches, 'quarterfinals', 9)).toEqual(matches);
    const result = drawModoItalianoBracketOpeningSongs(matches, 'quarterfinals', [9, 10], 1);
    expect(result.drawnSongIds).toEqual([]);
    expect(result.emptySlotCount).toBe(0);
    expect(result.availableSongCount).toBe(2);
  });
  it('removes duplicate opening entries, advances valid winners, and invalidates downstream results after a change', () => {
    const matches = createDefaultModoItalianoBracketMatches();
    matches[0] = { id: 1, songAId: 1, songBId: 2, winnerId: 1 };
    matches[1] = { id: 2, songAId: 2, songBId: 3, winnerId: 3 };
    matches[2] = { id: 3, songAId: 4, songBId: 3, winnerId: 99 };
    matches[8].winnerId = 1;
    const advanced = applyModoItalianoBracketAdvancement(matches);
    expect(advanced[1].songAId).toBeNull();
    expect(advanced[2]).toMatchObject({ songBId: null, winnerId: null });
    expect(advanced[8]).toMatchObject({ songAId: 1, songBId: 3, winnerId: 1 });
    expect(advanced[12].songAId).toBe(1);
    matches[0].winnerId = 2;
    const changed = applyModoItalianoBracketAdvancement(matches);
    expect(changed[8]).toMatchObject({ songAId: 2, songBId: 3, winnerId: null });
    expect(changed[12].songAId).toBeNull();
  });
  it('normalizes absent or invalid stored matches to the complete fifteen-match bracket', () => {
    expect(normalizeModoItalianoBracketMatches(undefined)).toHaveLength(15);
    const normalized = normalizeModoItalianoBracketMatches([
      null, false, { id: '1' }, { id: 0 }, { id: 16 }, { id: 1, songAId: '1', songBId: 2, winnerId: '2' },
    ]);
    expect(normalized[0]).toEqual({ id: 1, songAId: null, songBId: 2, winnerId: null });
    expect(normalized[14]).toEqual({ id: 15, songAId: null, songBId: null, winnerId: null });
  });
});
