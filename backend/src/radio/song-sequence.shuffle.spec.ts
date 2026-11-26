import {
  advanceProgramSongSequence,
  normalizeProgramSongSequence,
  programSongPlayOrder,
  removeProgramSongLeavesInPlace,
  type ProgramSongSequence,
} from './song-sequence.utils';

// gaulatti/alcantara#834: shuffle plays a stored order of its own; the rows stay in the operator's order.
const sequence = (overrides: Record<string, unknown> = {}) =>
  normalizeProgramSongSequence({
    mode: 'shuffle',
    loop: false,
    items: ['a', 'b', 'c', 'd'].map((id) => ({ id, title: id })),
    shuffleOrder: ['c', 'a', 'b'],
    activeItemId: 'c',
    ...overrides,
  })!;
const ids = (value: ProgramSongSequence) =>
  programSongPlayOrder(value).map((item) => item.id);

describe('shuffle play order', () => {
  it('follows the stored order, with an item added since after it', () => {
    expect(ids(sequence())).toEqual(['c', 'a', 'b', 'd']);
    expect(ids(sequence({ shuffleOrder: ['d'] }))).toEqual([
      'd',
      'a',
      'b',
      'c',
    ]);
  });

  it('is the rows outside shuffle, or without a stored order', () => {
    for (const overrides of [
      { mode: 'manual' },
      { mode: 'autoplay' },
      { shuffleOrder: [] },
      { shuffleOrder: undefined },
    ])
      expect(ids(sequence(overrides))).toEqual(['a', 'b', 'c', 'd']);
  });

  it('keeps only ids from a stored order', () => {
    expect(sequence({ shuffleOrder: ['b', 3, null] }).shuffleOrder).toEqual([
      'b',
    ]);
  });

  it('advances along the order once, then ends when loop is off', () => {
    const value = sequence();
    const played = [value.activeItemId];
    while (advanceProgramSongSequence(value, value.activeItemId))
      played.push(value.activeItemId);
    expect(played).toEqual(['c', 'a', 'b', 'd']);
    expect(value.items.map((item) => item.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('moves a removed cursor to the first of the order that remains', () => {
    const value = sequence();
    removeProgramSongLeavesInPlace(value, new Set(['c']));
    expect(value.activeItemId).toBe('a');
  });
});
