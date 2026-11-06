import {
  resolveProgramSongLeaf,
  type ProgramSongSequence,
  type ProgramSongSequenceLeafItem,
} from './song-sequence.utils';

const START = 1_700_000_000_000;

function leaf(id: string, durationMs?: number): ProgramSongSequenceLeafItem {
  return {
    id,
    kind: 'preset',
    artist: `Artist ${id}`,
    title: `Title ${id}`,
    coverUrl: '',
    audioUrl: `https://media.test/${id}.mp3`,
    ...(durationMs === undefined ? {} : { durationMs }),
  };
}

function sequence(
  items: ProgramSongSequenceLeafItem[],
  extra: Partial<ProgramSongSequence> = {},
): ProgramSongSequence {
  return {
    mode: 'autoplay',
    items,
    activeItemId: items[0].id,
    intervalMs: 4000,
    loop: true,
    startedAt: START,
    ...extra,
  };
}

describe('song sequence clock selection', () => {
  it('walks a looping cycle of known durations from the active item', () => {
    const looping = sequence([leaf('a', 1000), leaf('b', 2000)], {
      activeItemId: 'b',
    });

    expect(resolveProgramSongLeaf(looping, START + 500)?.id).toBe('b');
    expect(resolveProgramSongLeaf(looping, START + 2500)?.id).toBe('a');
    expect(resolveProgramSongLeaf(looping, START + 3500)?.id).toBe('b');
  });

  it('keeps the active item when the clock is not finite on a known cycle', () => {
    const looping = sequence([leaf('a', 1000), leaf('b', 2000)], {
      activeItemId: 'b',
    });

    expect(resolveProgramSongLeaf(looping, Number.NaN)?.id).toBe('b');
    expect(resolveProgramSongLeaf(looping, Number.POSITIVE_INFINITY)?.id).toBe(
      'b',
    );
  });

  it('stops at the first item with an unknown duration while looping', () => {
    const looping = sequence([leaf('a', 1000), leaf('b'), leaf('c', 1000)]);

    expect(resolveProgramSongLeaf(looping, START + 500)?.id).toBe('a');
    expect(resolveProgramSongLeaf(looping, START + 5000)?.id).toBe('b');
    expect(resolveProgramSongLeaf(looping, Number.NaN)?.id).toBe('b');
  });

  it('wraps to an unknown-duration item that precedes the active one', () => {
    const looping = sequence([leaf('a'), leaf('b', 1000)], {
      activeItemId: 'b',
    });

    expect(resolveProgramSongLeaf(looping, START + 1500)?.id).toBe('a');
  });

  it('plays a non-looping sequence to its end and then holds the last item', () => {
    const once = sequence([leaf('a', 1000), leaf('b', 1000), leaf('c', 1000)], {
      loop: false,
    });

    expect(resolveProgramSongLeaf(once, START + 500)?.id).toBe('a');
    expect(resolveProgramSongLeaf(once, START + 1500)?.id).toBe('b');
    expect(resolveProgramSongLeaf(once, START + 90_000)?.id).toBe('c');
  });

  it('holds a non-looping sequence on an item with an unknown duration', () => {
    const once = sequence([leaf('a', 1000), leaf('b'), leaf('c', 1000)], {
      loop: false,
    });

    expect(resolveProgramSongLeaf(once, START + 90_000)?.id).toBe('b');
  });

  it('returns the manually selected item regardless of the clock', () => {
    const manual = sequence([leaf('a', 1000), leaf('b', 1000)], {
      mode: 'manual',
      activeItemId: 'b',
    });

    expect(resolveProgramSongLeaf(manual, START + 90_000)?.id).toBe('b');
  });
});
