import {
  getProgramSongSequenceSelectedItemId,
  type ProgramSongSequence,
  type ProgramSongSequenceItem,
} from './song-sequence.utils';

const leaf = (id: string, durationMs?: number): ProgramSongSequenceItem => ({
  kind: 'preset',
  id,
  artist: '',
  title: id,
  coverUrl: '',
  durationMs,
});
const sequence = (
  items: ProgramSongSequenceItem[],
  overrides: Partial<ProgramSongSequence> = {},
): ProgramSongSequence => ({
  mode: 'autoplay',
  items,
  activeItemId: 'a',
  startedAt: 0,
  loop: true,
  intervalMs: 4000,
  ...overrides,
});
// A playlist can reach selection with an empty slot (a sparse array); elapsed
// time landing on it must report no item rather than throwing.
const withEmptySlot = (
  items: ProgramSongSequenceItem[],
  slot: number,
): ProgramSongSequenceItem[] => {
  const sparse = [...items];
  Reflect.deleteProperty(sparse, slot);
  return sparse;
};

describe('autoplay selection boundaries', () => {
  it('treats a sequence without a start time as having just started', () => {
    const items = [leaf('a', 1000), leaf('b', 1000)];
    expect(
      getProgramSongSequenceSelectedItemId(
        sequence(items, { startedAt: undefined }),
        5000,
      ),
    ).toBe('a');
    expect(
      getProgramSongSequenceSelectedItemId(
        sequence(items, { startedAt: 0 }),
        1000,
      ),
    ).toBe('b');
  });

  it.each([
    [
      'a looped playlist whose durations are all known',
      sequence(withEmptySlot([leaf('a', 10), leaf('x'), leaf('b', 10)], 1)),
    ],
    [
      'a looped playlist with an unknown duration after the gap',
      sequence(withEmptySlot([leaf('a', 10), leaf('x'), leaf('c')], 1)),
    ],
    [
      'a non-looping playlist with a gap before the last slot',
      sequence(withEmptySlot([leaf('a', 10), leaf('x'), leaf('c', 10)], 1), {
        loop: false,
      }),
    ],
    [
      'a non-looping playlist whose last slot is the gap',
      sequence(withEmptySlot([leaf('a', 10), leaf('x')], 1), { loop: false }),
    ],
  ])(
    'reports no selection when elapsed time lands on a gap in %s',
    (_name, input) => {
      expect(getProgramSongSequenceSelectedItemId(input, 10)).toBeNull();
    },
  );
});
