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
  activeItemId: string,
  startedAt: number,
): ProgramSongSequence => ({
  mode: 'autoplay',
  items,
  activeItemId,
  startedAt,
  loop: true,
  intervalMs: 4000,
});

describe('autoplay traversal arithmetic and unknown-duration boundaries', () => {
  it.each(['first', 'second', 'third'])(
    'stops on the concrete unknown item from base %s even when elapsed arithmetic overflows',
    (base) => {
      const input = sequence(
        [
          leaf('first', Number.MAX_VALUE),
          leaf('second'),
          leaf('third', Number.MAX_VALUE),
        ],
        base,
        -Number.MAX_VALUE,
      );
      expect(
        getProgramSongSequenceSelectedItemId(input, Number.MAX_VALUE),
      ).toBe('second');
    },
  );

  it('clamps every positive known duration to at least one millisecond before calculating a loop', () => {
    const input = sequence(
      [leaf('first', Number.MIN_VALUE), leaf('second', 0.1)],
      'first',
      0,
    );
    expect(getProgramSongSequenceSelectedItemId(input, 0)).toBe('first');
    expect(getProgramSongSequenceSelectedItemId(input, 1)).toBe('second');
    expect(getProgramSongSequenceSelectedItemId(input, 2)).toBe('first');
  });

  it('keeps the known-duration numeric overflow fallback and a sparse-array guard intact', () => {
    const overflowing = sequence(
      [leaf('first', Number.MAX_VALUE), leaf('second', Number.MAX_VALUE)],
      'first',
      -Number.MAX_VALUE,
    );
    expect(
      getProgramSongSequenceSelectedItemId(overflowing, Number.MAX_VALUE),
    ).toBe('first');
    const sparse = [leaf('first', 10)];
    sparse.length = 2;
    expect(
      getProgramSongSequenceSelectedItemId(
        sequence(sparse, 'first', -Number.MAX_VALUE),
        Number.MAX_VALUE,
      ),
    ).toBeNull();
  });
});
