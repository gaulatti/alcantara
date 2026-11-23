import { describe, expect, it } from 'vitest';
import { chartLookupId, readChartSongValues, resolveChartDisplay, type ChartSongValues, type ChartValues } from './programChartValues';

// The realtime chart entry the program page matches today, mapped to rank and spins.
const realtime: ChartValues = { rank: '3', spins: '1450' };

// The program page's chart expression before the generic fields were read, kept verbatim as the oracle:
// scene prop, then the realtime entry, then the song's legacy value.
function legacyDisplay(scene: ChartValues, realtimeEntry: ChartValues | null, legacy: ChartValues): ChartValues {
  return {
    rank: scene.rank || realtimeEntry?.rank || legacy.rank,
    spins: scene.spins || realtimeEntry?.spins || legacy.spins
  };
}

describe('program page chart values', () => {
  it('reads the generic chart fields of a stored song as trimmed strings', () => {
    expect(
      readChartSongValues({
        externalChartId: 101,
        externalChartSongId: ' 101 ',
        externalChartRank: '3',
        externalChartSpins: 1450
      })
    ).toEqual({
      externalChartId: '101',
      externalChartSongId: '101',
      externalChartRank: '3',
      externalChartSpins: '1450'
    });
  });

  it('reads absent, blank, null and non-finite generic fields as absent', () => {
    expect(
      readChartSongValues({ externalChartId: '   ', externalChartSongId: null, externalChartRank: Number.NaN, externalChartSpins: {} })
    ).toEqual({ externalChartId: undefined, externalChartSongId: undefined, externalChartRank: undefined, externalChartSpins: undefined });
    expect(readChartSongValues({})).toEqual({
      externalChartId: undefined,
      externalChartSongId: undefined,
      externalChartRank: undefined,
      externalChartSpins: undefined
    });
  });

  it('takes rank and spins from the generic fields when the song carries them, over the realtime entry', () => {
    const song = readChartSongValues({ externalChartRank: '4', externalChartSpins: '1500' });

    expect(resolveChartDisplay({ scene: {}, song, realtime, legacy: { rank: '9', spins: '9' } })).toEqual({ rank: '4', spins: '1500' });
  });

  it('shows the same rank and spins from the generic fields as today from the realtime entry', () => {
    const song = readChartSongValues({ externalChartId: '101', externalChartRank: '3', externalChartSpins: '1450' });

    const today = legacyDisplay({}, realtime, {});
    expect(resolveChartDisplay({ scene: {}, song, realtime: null, legacy: {} })).toEqual(today);
  });

  it('resolves exactly as today when the song has no generic fields', () => {
    const songs: Array<ChartSongValues | null | undefined> = [readChartSongValues({}), null, undefined];
    const scenes: ChartValues[] = [{}, { rank: '1' }, { spins: '2' }, { rank: '', spins: '' }, { rank: 0, spins: 0 }];
    const realtimeEntries: Array<ChartValues | null> = [realtime, { rank: null, spins: null }, { rank: '7' }, null];
    const legacies: ChartValues[] = [{}, { rank: '50', spins: '5' }, { rank: '50' }, { rank: '', spins: null }];

    for (const song of songs) {
      for (const scene of scenes) {
        for (const realtimeEntry of realtimeEntries) {
          for (const legacy of legacies) {
            expect(resolveChartDisplay({ scene, song, realtime: realtimeEntry, legacy })).toStrictEqual(
              legacyDisplay(scene, realtimeEntry, legacy)
            );
          }
        }
      }
    }
  });

  it('takes each value on its own when the song carries only some generic fields', () => {
    const rankOnly = readChartSongValues({ externalChartRank: '2' });
    expect(resolveChartDisplay({ scene: {}, song: rankOnly, realtime, legacy: {} })).toEqual({ rank: '2', spins: '1450' });

    const spinsOnly = readChartSongValues({ externalChartSpins: '1600' });
    expect(resolveChartDisplay({ scene: {}, song: spinsOnly, realtime, legacy: {} })).toEqual({ rank: '3', spins: '1600' });

    expect(resolveChartDisplay({ scene: {}, song: rankOnly, realtime: null, legacy: { spins: '77' } })).toEqual({ rank: '2', spins: '77' });
  });

  it('keeps the scene values ahead of the generic fields', () => {
    const song = readChartSongValues({ externalChartRank: '4', externalChartSpins: '1500' });

    expect(resolveChartDisplay({ scene: { rank: '1', spins: '10' }, song, realtime, legacy: {} })).toEqual({ rank: '1', spins: '10' });
  });

  it('finds the realtime entry by the legacy id first, else by the generic chart id', () => {
    expect(chartLookupId('101', readChartSongValues({ externalChartId: '202' }))).toBe('101');
    expect(chartLookupId(undefined, readChartSongValues({ externalChartId: '202', externalChartSongId: '303' }))).toBe('202');
    expect(chartLookupId(undefined, readChartSongValues({ externalChartSongId: '303' }))).toBe('303');
  });

  it('finds the realtime entry by the legacy id alone when the song has no generic fields, as today', () => {
    for (const legacyId of ['101', '', null, undefined]) {
      for (const song of [readChartSongValues({}), null, undefined]) {
        expect(chartLookupId(legacyId, song)).toBe(legacyId || null);
      }
    }
  });
});
