import {
  activateProgramSongLeaf,
  advanceProgramSongSequence,
  collectHighRotationProgramSongLeaves,
  collectProgramSongLeaves,
  findUniqueProgramSongLeafByAudioUrl,
  findUniqueProgramSongLeafById,
  getProgramSongSequenceSelectedItemId,
  normalizeProgramSongSequence,
  resolveProgramSongLeaf,
  type ProgramSongSequence,
  type ProgramSongSequenceItem,
  type ProgramSongSequenceLeafItem,
} from './song-sequence.utils';

const NOW = 1_700_000_000_000;

function leaf(
  id: string,
  extra: Partial<ProgramSongSequenceLeafItem> = {},
): ProgramSongSequenceLeafItem {
  return {
    id,
    kind: 'preset',
    artist: `Artist ${id}`,
    title: `Title ${id}`,
    coverUrl: '',
    audioUrl: `https://media.test/${id}.mp3`,
    ...extra,
  };
}

function nested(
  id: string,
  sequence: ProgramSongSequence,
  label = `Label ${id}`,
): ProgramSongSequenceItem {
  return { id, kind: 'sequence', label, sequence };
}

function seq(
  items: ProgramSongSequenceItem[],
  extra: Partial<ProgramSongSequence> = {},
): ProgramSongSequence {
  return {
    mode: 'autoplay',
    items,
    activeItemId: items[0]?.id ?? null,
    intervalMs: 4000,
    loop: true,
    startedAt: NOW,
    ...extra,
  };
}

function deepChain(levels: number): ProgramSongSequence {
  let current = seq([leaf('deep')]);
  for (let index = 0; index < levels; index += 1) {
    current = seq([nested(`n${index}`, current)]);
  }
  return current;
}

describe('program song sequence normalization', () => {
  beforeEach(() => {
    jest.spyOn(Date, 'now').mockReturnValue(NOW);
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns null for non-record input', () => {
    expect(normalizeProgramSongSequence(null)).toBeNull();
    expect(normalizeProgramSongSequence('x')).toBeNull();
    expect(normalizeProgramSongSequence([])).toBeNull();
  });

  it('returns null when nested deeper than the supported depth', () => {
    expect(normalizeProgramSongSequence({ items: [] }, 9)).toBeNull();
    expect(normalizeProgramSongSequence({ items: [] }, 8)).not.toBeNull();
  });

  it('drops nested sequences beyond the depth limit and non-record items', () => {
    let value: Record<string, unknown> = {
      items: [{ id: 'deep', kind: 'preset' }],
    };
    for (let index = 0; index < 10; index += 1) {
      value = {
        items: [{ id: `n${index}`, kind: 'sequence', sequence: value }],
      };
    }
    const result = normalizeProgramSongSequence(value);
    let depth = 0;
    let current = result;
    while (current && current.items[0]?.kind === 'sequence') {
      current = (current.items[0] as { sequence: ProgramSongSequence })
        .sequence;
      depth += 1;
    }
    expect(depth).toBe(8);
    expect(current?.items).toEqual([]);

    expect(
      normalizeProgramSongSequence({
        items: [null, 4, 'x', [], { id: 'ok' }],
      })?.items.map((item) => item.id),
    ).toEqual(['ok']);
  });

  it('treats a non-array items value as an empty list', () => {
    const result = normalizeProgramSongSequence({ items: 'nope' });
    expect(result?.items).toEqual([]);
    expect(result?.activeItemId).toBeNull();
  });

  it('normalizes the mode', () => {
    expect(normalizeProgramSongSequence({})?.mode).toBe('autoplay');
    expect(normalizeProgramSongSequence({ mode: 'bogus' })?.mode).toBe(
      'autoplay',
    );
    expect(normalizeProgramSongSequence({ mode: 'shuffle' })?.mode).toBe(
      'shuffle',
    );
    expect(normalizeProgramSongSequence({ mode: 'manual' })?.mode).toBe(
      'manual',
    );
  });

  it('normalizes the active item id', () => {
    const items = [{ id: 'a' }, { id: 'b' }];
    expect(
      normalizeProgramSongSequence({ items, activeItemId: null })?.activeItemId,
    ).toBeNull();
    expect(
      normalizeProgramSongSequence({ items, activeItemId: 'b' })?.activeItemId,
    ).toBe('b');
    expect(
      normalizeProgramSongSequence({ items, activeItemId: 'zzz' })
        ?.activeItemId,
    ).toBe('a');
    expect(
      normalizeProgramSongSequence({ items, activeItemId: 5 })?.activeItemId,
    ).toBe('a');
    expect(normalizeProgramSongSequence({ items })?.activeItemId).toBe('a');
  });

  it('normalizes interval, loop and startedAt', () => {
    expect(normalizeProgramSongSequence({})).toMatchObject({
      intervalMs: 4000,
      loop: true,
      startedAt: NOW,
    });
    expect(
      normalizeProgramSongSequence({
        intervalMs: 1234.9,
        loop: false,
        startedAt: 99,
      }),
    ).toMatchObject({ intervalMs: 1234, loop: false, startedAt: 99 });
    expect(
      normalizeProgramSongSequence({
        intervalMs: 499,
        loop: 0,
        startedAt: Number.NaN,
      }),
    ).toMatchObject({ intervalMs: 4000, loop: false, startedAt: NOW });
    expect(
      normalizeProgramSongSequence({ intervalMs: Infinity, startedAt: '5' }),
    ).toMatchObject({ intervalMs: 4000, startedAt: NOW });
    expect(normalizeProgramSongSequence({ intervalMs: '5000' })).toMatchObject({
      intervalMs: 4000,
    });
  });

  it('normalizes leaf fields with defaults', () => {
    const result = normalizeProgramSongSequence({ items: [{}] });
    expect(result?.items[0]).toEqual({
      id: `song_${NOW.toString(36)}`,
      kind: 'preset',
      songId: undefined,
      highRotation: false,
      artist: '',
      title: '',
      coverUrl: '',
      audioUrl: undefined,
      durationMs: undefined,
      earoneSongId: undefined,
      earoneRank: undefined,
      earoneSpins: undefined,
    });
  });

  it('keeps and trims valid leaf fields', () => {
    const result = normalizeProgramSongSequence({
      items: [
        {
          id: 'x',
          songId: 12,
          highRotation: true,
          artist: ' A ',
          title: ' T ',
          coverUrl: ' c ',
          audioUrl: ' u ',
          durationMs: 1000.4,
          earoneSongId: ' e ',
          earoneRank: ' 3 ',
          earoneSpins: ' 9 ',
        },
      ],
    });
    expect(result?.items[0]).toEqual({
      id: 'x',
      kind: 'preset',
      songId: 12,
      highRotation: true,
      artist: 'A',
      title: 'T',
      coverUrl: 'c',
      audioUrl: 'u',
      durationMs: 1000,
      earoneSongId: 'e',
      earoneRank: '3',
      earoneSpins: '9',
    });
  });

  it('converts numeric earone ids and spins and rejects invalid leaf values', () => {
    const numeric = normalizeProgramSongSequence({
      items: [{ id: 'x', earoneSongId: 42, earoneSpins: 7 }],
    })?.items[0] as ProgramSongSequenceLeafItem;
    expect(numeric.earoneSongId).toBe('42');
    expect(numeric.earoneSpins).toBe('7');

    const invalid = normalizeProgramSongSequence({
      items: [
        {
          id: '',
          songId: 1.5,
          highRotation: 'yes',
          artist: 5,
          title: '   ',
          coverUrl: 5,
          audioUrl: '  ',
          durationMs: -1,
          earoneSongId: Number.NaN,
          earoneRank: '  ',
          earoneSpins: Infinity,
        },
        {
          id: 'y',
          songId: 0,
          durationMs: Number.NaN,
          earoneSongId: '  ',
          earoneSpins: '  ',
        },
        {
          id: 'z',
          songId: 'a',
          durationMs: 'a',
          earoneSongId: {},
          earoneSpins: {},
          earoneRank: 4,
        },
      ],
    })?.items as ProgramSongSequenceLeafItem[];
    expect(invalid[0]).toEqual({
      id: `song_${NOW.toString(36)}`,
      kind: 'preset',
      songId: undefined,
      highRotation: false,
      artist: '',
      title: '',
      coverUrl: '',
      audioUrl: undefined,
      durationMs: undefined,
      earoneSongId: undefined,
      earoneRank: undefined,
      earoneSpins: undefined,
    });
    expect(invalid[1].songId).toBeUndefined();
    expect(invalid[1].durationMs).toBeUndefined();
    expect(invalid[1].earoneSongId).toBeUndefined();
    expect(invalid[1].earoneSpins).toBeUndefined();
    expect(invalid[2].songId).toBeUndefined();
    expect(invalid[2].durationMs).toBeUndefined();
    expect(invalid[2].earoneSongId).toBeUndefined();
    expect(invalid[2].earoneSpins).toBeUndefined();
    expect(invalid[2].earoneRank).toBeUndefined();
  });

  it('normalizes nested sequences with ids and labels', () => {
    const result = normalizeProgramSongSequence({
      items: [
        { kind: 'sequence', sequence: { items: [] } },
        {
          id: 'named',
          kind: 'sequence',
          label: 'Morning',
          sequence: { items: [{ id: 'inner' }] },
        },
        { id: 'blank', kind: 'sequence', label: '   ', sequence: {} },
        { id: 'bad', kind: 'sequence', sequence: 'nope' },
      ],
    });
    expect(result?.items.map((item) => item.id)).toEqual([
      `sequence_${NOW.toString(36)}`,
      'named',
      'blank',
    ]);
    expect(
      result?.items.map((item) => (item as { label: string }).label),
    ).toEqual(['Nested Sequence', 'Morning', 'Nested Sequence']);
  });
});

describe('advanceProgramSongSequence', () => {
  beforeEach(() => {
    jest.spyOn(Date, 'now').mockReturnValue(NOW + 5);
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('moves to the next sibling after the given leaf', () => {
    const sequence = seq([leaf('a'), leaf('b')]);
    expect(advanceProgramSongSequence(sequence, ' a ')).toBe(true);
    expect(sequence.activeItemId).toBe('b');
    expect(sequence.startedAt).toBe(NOW + 5);
  });

  it('resets the cursor of a following nested sequence', () => {
    const inner = seq([nested('deep', seq([leaf('x'), leaf('y')]))], {
      activeItemId: 'deep',
    });
    inner.items[0] = nested(
      'deep',
      seq([leaf('x'), leaf('y')], { activeItemId: 'y' }),
    );
    const sequence = seq([leaf('a'), nested('group', inner)]);
    expect(advanceProgramSongSequence(sequence, 'a')).toBe(true);
    expect(sequence.activeItemId).toBe('group');
    expect(inner.activeItemId).toBe('deep');
    expect(
      (inner.items[0] as { sequence: ProgramSongSequence }).sequence
        .activeItemId,
    ).toBe('x');
  });

  it('loops back to the first item after the last leaf', () => {
    const sequence = seq([leaf('a'), leaf('b')], { activeItemId: 'b' });
    expect(advanceProgramSongSequence(sequence, 'b')).toBe(true);
    expect(sequence.activeItemId).toBe('a');
    expect(sequence.startedAt).toBe(NOW + 5);
  });

  it('loops when loop is undefined and stops only on explicit false', () => {
    const sequence = seq([leaf('a')]);
    (sequence as { loop?: boolean }).loop = undefined;
    expect(advanceProgramSongSequence(sequence, 'a')).toBe(true);
  });

  it('exhausts a non-looping sequence after the last leaf', () => {
    const sequence = seq([leaf('a'), leaf('b')], {
      activeItemId: 'b',
      loop: false,
    });
    expect(advanceProgramSongSequence(sequence, 'b')).toBe(false);
    expect(sequence.activeItemId).toBeNull();
  });

  it('advances inside a nested sequence when it has a next item', () => {
    const inner = seq([leaf('x'), leaf('y')], { activeItemId: 'x' });
    const sequence = seq([nested('group', inner), leaf('z')]);
    expect(advanceProgramSongSequence(sequence, 'x')).toBe(true);
    expect(inner.activeItemId).toBe('y');
    expect(sequence.activeItemId).toBe('group');
  });

  it('moves past an exhausted nested sequence to the parent successor', () => {
    const inner = seq([leaf('x')], { loop: false });
    const following = seq([leaf('p'), leaf('q')], { activeItemId: 'q' });
    const sequence = seq([nested('group', inner), nested('next', following)]);
    expect(advanceProgramSongSequence(sequence, 'x')).toBe(true);
    expect(inner.activeItemId).toBeNull();
    expect(sequence.activeItemId).toBe('next');
    expect(following.activeItemId).toBe('p');
  });

  it('loops the parent when the last nested sequence is exhausted', () => {
    const inner = seq([leaf('x')], { loop: false });
    const sequence = seq([leaf('a'), nested('group', inner)], {
      activeItemId: 'group',
    });
    expect(advanceProgramSongSequence(sequence, 'x')).toBe(true);
    expect(sequence.activeItemId).toBe('a');
  });

  it('exhausts the parent when it cannot loop either', () => {
    const inner = seq([leaf('x')], { loop: false });
    const sequence = seq([nested('group', inner)], { loop: false });
    expect(advanceProgramSongSequence(sequence, 'x')).toBe(false);
    expect(sequence.activeItemId).toBeNull();
  });

  it('resets nested cursors recursively when looping to a nested first item', () => {
    const deepInner = seq([leaf('d1'), leaf('d2')], { activeItemId: 'd2' });
    const mid = seq([nested('deep', deepInner)], { activeItemId: 'deep' });
    const sequence = seq([nested('mid', mid), leaf('last')], {
      activeItemId: 'last',
    });
    expect(advanceProgramSongSequence(sequence, 'last')).toBe(true);
    expect(sequence.activeItemId).toBe('mid');
    expect(deepInner.activeItemId).toBe('d1');
  });

  it('resets an empty-first cursor to null', () => {
    const empty = seq([]);
    const sequence = seq([leaf('a'), nested('empty', empty)], {
      activeItemId: 'a',
    });
    expect(advanceProgramSongSequence(sequence, 'a')).toBe(true);
    expect(sequence.activeItemId).toBe('empty');
    expect(empty.activeItemId).toBeNull();
  });

  it('falls back to the active cursor when the leaf is unknown or absent', () => {
    const sequence = seq([leaf('a'), leaf('b')], { activeItemId: 'a' });
    expect(advanceProgramSongSequence(sequence, 'missing')).toBe(true);
    expect(sequence.activeItemId).toBe('b');
    expect(advanceProgramSongSequence(sequence, '   ')).toBe(true);
    expect(sequence.activeItemId).toBe('a');
    expect(advanceProgramSongSequence(sequence, null)).toBe(true);
    expect(advanceProgramSongSequence(sequence)).toBe(true);
  });

  it('recovers a stale cursor in a looping sequence', () => {
    const sequence = seq([leaf('a'), leaf('b')], { activeItemId: 'stale' });
    expect(advanceProgramSongSequence(sequence)).toBe(true);
    expect(sequence.activeItemId).toBe('a');
    expect(sequence.startedAt).toBe(NOW + 5);
  });

  it('does not recover a stale cursor without loop or items', () => {
    const noLoop = seq([leaf('a')], { activeItemId: 'stale', loop: false });
    expect(advanceProgramSongSequence(noLoop)).toBe(false);
    const empty = seq([], { activeItemId: null });
    expect(advanceProgramSongSequence(empty)).toBe(false);
  });

  it('advances from an active nested sequence by its resolved leaf', () => {
    const inner = seq([leaf('x'), leaf('y')], { activeItemId: 'x' });
    const sequence = seq([nested('group', inner), leaf('z')], {
      activeItemId: 'group',
    });
    expect(advanceProgramSongSequence(sequence)).toBe(true);
    expect(inner.activeItemId).toBe('y');
  });

  it('moves to the next item when the active nested sequence has no leaf', () => {
    const sequence = seq([nested('group', seq([])), leaf('z')], {
      activeItemId: 'group',
    });
    expect(advanceProgramSongSequence(sequence)).toBe(true);
    expect(sequence.activeItemId).toBe('z');
  });

  it('moves to a following nested sequence and resets its cursor', () => {
    const following = seq([leaf('p'), leaf('q')], { activeItemId: 'q' });
    const sequence = seq([leaf('a'), nested('next', following)], {
      activeItemId: 'a',
    });
    expect(advanceProgramSongSequence(sequence)).toBe(true);
    expect(sequence.activeItemId).toBe('next');
    expect(following.activeItemId).toBe('p');
  });

  it('loops or stops when the active item is the last one', () => {
    const looping = seq([nested('group', seq([]))], {
      activeItemId: 'group',
    });
    expect(advanceProgramSongSequence(looping)).toBe(true);
    expect(looping.activeItemId).toBe('group');

    const stopping = seq([leaf('a')], { activeItemId: 'a', loop: false });
    expect(advanceProgramSongSequence(stopping)).toBe(false);
    expect(stopping.activeItemId).toBeNull();
  });

  it('falls through when the resolved nested leaf cannot be advanced', () => {
    // The resolved leaf of a nested sequence beyond the depth limit is null,
    // so advancement uses the sibling cursor instead.
    const sequence = seq([nested('deep', deepChain(10)), leaf('z')], {
      activeItemId: 'deep',
    });
    expect(advanceProgramSongSequence(sequence)).toBe(true);
    expect(sequence.activeItemId).toBe('z');
  });
});

describe('resolving and selecting song leaves', () => {
  it('returns null for missing, empty or cursorless sequences', () => {
    expect(resolveProgramSongLeaf(null)).toBeNull();
    expect(resolveProgramSongLeaf(seq([]), NOW)).toBeNull();
    expect(
      resolveProgramSongLeaf(seq([leaf('a')], { activeItemId: null }), NOW),
    ).toBeNull();
    expect(
      getProgramSongSequenceSelectedItemId(
        seq([leaf('a')], { activeItemId: null }),
        NOW,
      ),
    ).toBeNull();
  });

  it('defaults the clock to Date.now', () => {
    const spy = jest.spyOn(Date, 'now').mockReturnValue(NOW);
    try {
      expect(resolveProgramSongLeaf(seq([leaf('a')]))?.id).toBe('a');
      expect(getProgramSongSequenceSelectedItemId(seq([leaf('a')]))).toBe('a');
    } finally {
      spy.mockRestore();
    }
  });

  it('uses the first item for an unknown cursor and honours manual mode', () => {
    const items = [leaf('a'), leaf('b')];
    expect(
      resolveProgramSongLeaf(seq(items, { activeItemId: 'zzz' }), NOW)?.id,
    ).toBe('a');
    expect(
      resolveProgramSongLeaf(
        seq(items, { mode: 'manual', activeItemId: 'b' }),
        NOW + 10_000_000,
      )?.id,
    ).toBe('b');
  });

  it('builds a path of labels through nested sequences', () => {
    const inner = seq([leaf('x', { artist: '', title: '' })]);
    const middle = seq([nested('in', inner, 'Inner')]);
    const result = resolveProgramSongLeaf(
      seq([nested('mid', middle, 'Middle')]),
      NOW,
    );
    expect(result?.id).toBe('x');
    expect(result?.activePathLabels).toEqual([
      'Middle',
      'Inner',
      'Song Preset',
    ]);
    expect(result?.highRotation).toBe(false);
  });

  it('labels with artist only or title only', () => {
    expect(
      resolveProgramSongLeaf(seq([leaf('a', { title: '' })]), NOW)
        ?.activePathLabels,
    ).toEqual(['Artist a']);
    expect(
      resolveProgramSongLeaf(seq([leaf('a', { artist: '' })]), NOW)
        ?.activePathLabels,
    ).toEqual(['Title a']);
  });

  it('returns null beyond the supported nesting depth', () => {
    expect(resolveProgramSongLeaf(deepChain(10), NOW)).toBeNull();
    expect(resolveProgramSongLeaf(deepChain(8), NOW)?.id).toBe('deep');
  });

  it('treats an undefined startedAt as the evaluation time', () => {
    const sequence = seq([
      leaf('a', { durationMs: 1000 }),
      leaf('b', { durationMs: 1000 }),
    ]);
    (sequence as { startedAt?: number }).startedAt = undefined;
    expect(resolveProgramSongLeaf(sequence, NOW)?.id).toBe('a');
  });

  it('clamps negative elapsed time to zero', () => {
    const sequence = seq(
      [leaf('a', { durationMs: 1000 }), leaf('b', { durationMs: 1000 })],
      { startedAt: NOW + 5000 },
    );
    expect(resolveProgramSongLeaf(sequence, NOW)?.id).toBe('a');
  });

  describe('looping with known durations', () => {
    const sequence = () =>
      seq([
        leaf('a', { durationMs: 1000 }),
        leaf('b', { durationMs: 2000 }),
        leaf('c', { durationMs: 3000 }),
      ]);

    it('selects by elapsed time within the cycle', () => {
      expect(resolveProgramSongLeaf(sequence(), NOW + 500)?.id).toBe('a');
      expect(resolveProgramSongLeaf(sequence(), NOW + 1500)?.id).toBe('b');
      expect(resolveProgramSongLeaf(sequence(), NOW + 3500)?.id).toBe('c');
    });

    it('wraps around the cycle and rotates from the cursor', () => {
      expect(resolveProgramSongLeaf(sequence(), NOW + 6500)?.id).toBe('a');
      const rotated = seq(sequence().items, { activeItemId: 'b' });
      expect(resolveProgramSongLeaf(rotated, NOW + 500)?.id).toBe('b');
      expect(resolveProgramSongLeaf(rotated, NOW + 2500)?.id).toBe('c');
      expect(resolveProgramSongLeaf(rotated, NOW + 5500)?.id).toBe('a');
    });
  });

  describe('looping with unknown durations', () => {
    it('stops at the first item without a known duration', () => {
      const sequence = seq([leaf('a'), leaf('b', { durationMs: 1000 })]);
      expect(resolveProgramSongLeaf(sequence, NOW + 10_000)?.id).toBe('a');
    });

    it('skips known-duration items that have elapsed', () => {
      const sequence = seq([
        leaf('a', { durationMs: 1000 }),
        leaf('b', { durationMs: 1000 }),
        leaf('c'),
      ]);
      expect(resolveProgramSongLeaf(sequence, NOW + 500)?.id).toBe('a');
      expect(resolveProgramSongLeaf(sequence, NOW + 1500)?.id).toBe('b');
      expect(resolveProgramSongLeaf(sequence, NOW + 5000)?.id).toBe('c');
    });

    it('treats nested sequences as unknown durations', () => {
      const sequence = seq([
        leaf('a', { durationMs: 1000 }),
        nested('group', seq([leaf('x')])),
      ]);
      expect(resolveProgramSongLeaf(sequence, NOW + 2000)?.id).toBe('x');
    });
  });

  describe('non-looping playback', () => {
    it('advances through known durations and stays on the last item', () => {
      const sequence = seq(
        [
          leaf('a', { durationMs: 1000 }),
          leaf('b', { durationMs: 1000 }),
          leaf('c', { durationMs: 1000 }),
        ],
        { loop: false },
      );
      expect(resolveProgramSongLeaf(sequence, NOW + 500)?.id).toBe('a');
      expect(resolveProgramSongLeaf(sequence, NOW + 1500)?.id).toBe('b');
      expect(resolveProgramSongLeaf(sequence, NOW + 99_000)?.id).toBe('c');
    });

    it('stops at an item without a known duration', () => {
      const sequence = seq(
        [leaf('a', { durationMs: 1000 }), leaf('b'), leaf('c')],
        { loop: false },
      );
      expect(resolveProgramSongLeaf(sequence, NOW + 99_000)?.id).toBe('b');
    });
  });
});

describe('collecting and finding song leaves', () => {
  const tree = () =>
    seq([
      leaf('a', { highRotation: true }),
      nested(
        'group',
        seq([
          leaf('b', { artist: '', title: '' }),
          leaf('c', { audioUrl: 'https://media.test/shared.mp3' }),
        ]),
        'Group',
      ),
      leaf('d', { audioUrl: 'https://media.test/shared.mp3' }),
    ]);

  it('collects all leaves with their label paths', () => {
    const leaves = collectProgramSongLeaves(tree());
    expect(leaves.map((item) => item.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(leaves[1].activePathLabels).toEqual(['Group', 'Song Preset']);
    expect(leaves[0].highRotation).toBe(true);
    expect(leaves[1].highRotation).toBe(false);
  });

  it('collects nothing for a missing sequence and nothing beyond the depth limit', () => {
    expect(collectProgramSongLeaves(null)).toEqual([]);
    expect(collectProgramSongLeaves(deepChain(10))).toEqual([]);
    expect(collectProgramSongLeaves(deepChain(8))).toHaveLength(1);
  });

  it('collects only high rotation leaves', () => {
    expect(
      collectHighRotationProgramSongLeaves(tree()).map((item) => item.id),
    ).toEqual(['a']);
    expect(collectHighRotationProgramSongLeaves(null)).toEqual([]);
  });

  it('finds a unique leaf by id including nested label paths', () => {
    const found = findUniqueProgramSongLeafById(tree(), ' b ');
    expect(found?.id).toBe('b');
    expect(found?.activePathLabels).toEqual(['Group', 'Song Preset']);
    expect(findUniqueProgramSongLeafById(tree(), 'a')?.highRotation).toBe(true);
    expect(
      findUniqueProgramSongLeafById(tree(), 'a')?.activePathLabels,
    ).toEqual(['Artist a - Title a']);
  });

  it('returns null for blank, missing, null-sequence and ambiguous ids', () => {
    expect(findUniqueProgramSongLeafById(tree(), '  ')).toBeNull();
    expect(findUniqueProgramSongLeafById(null, 'a')).toBeNull();
    expect(findUniqueProgramSongLeafById(tree(), 'zzz')).toBeNull();
    const duplicate = seq([
      leaf('dup'),
      nested('group', seq([leaf('dup'), leaf('dup')])),
      leaf('dup'),
    ]);
    expect(findUniqueProgramSongLeafById(duplicate, 'dup')).toBeNull();
    expect(findUniqueProgramSongLeafById(deepChain(10), 'deep')).toBeNull();
    expect(findUniqueProgramSongLeafById(deepChain(8), 'deep')?.id).toBe(
      'deep',
    );
  });

  it('finds a unique leaf by audio url', () => {
    const found = findUniqueProgramSongLeafByAudioUrl(
      tree(),
      ' https://media.test/b.mp3 ',
    );
    expect(found?.id).toBe('b');
    expect(found?.activePathLabels).toEqual(['Group', 'Song Preset']);
    expect(
      findUniqueProgramSongLeafByAudioUrl(tree(), 'https://media.test/a.mp3')
        ?.activePathLabels,
    ).toEqual(['Artist a - Title a']);
    expect(
      findUniqueProgramSongLeafByAudioUrl(tree(), 'https://media.test/a.mp3')
        ?.highRotation,
    ).toBe(true);
  });

  it('returns null for blank, missing, null-sequence and ambiguous audio urls', () => {
    expect(findUniqueProgramSongLeafByAudioUrl(tree(), '  ')).toBeNull();
    expect(findUniqueProgramSongLeafByAudioUrl(null, 'x')).toBeNull();
    expect(
      findUniqueProgramSongLeafByAudioUrl(tree(), 'https://media.test/none'),
    ).toBeNull();
    expect(
      findUniqueProgramSongLeafByAudioUrl(
        tree(),
        'https://media.test/shared.mp3',
      ),
    ).toBeNull();
    const triple = seq([
      leaf('a', { audioUrl: 'u' }),
      leaf('b', { audioUrl: 'u' }),
      leaf('c', { audioUrl: 'u' }),
      nested('g', seq([leaf('d', { audioUrl: 'u' })])),
    ]);
    expect(findUniqueProgramSongLeafByAudioUrl(triple, 'u')).toBeNull();
    expect(
      findUniqueProgramSongLeafByAudioUrl(
        deepChain(10),
        'https://media.test/deep.mp3',
      ),
    ).toBeNull();
    expect(
      findUniqueProgramSongLeafByAudioUrl(
        deepChain(8),
        'https://media.test/deep.mp3',
      )?.id,
    ).toBe('deep');
  });
});

describe('activateProgramSongLeaf', () => {
  beforeEach(() => {
    jest.spyOn(Date, 'now').mockReturnValue(NOW + 7);
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('activates a top-level leaf', () => {
    const sequence = seq([leaf('a'), leaf('b')]);
    expect(activateProgramSongLeaf(sequence, 'b')).toBe(true);
    expect(sequence.activeItemId).toBe('b');
    expect(sequence.startedAt).toBe(NOW + 7);
  });

  it('activates the whole path to a nested leaf', () => {
    const inner = seq([leaf('x'), leaf('y')]);
    const sequence = seq([leaf('a'), nested('group', inner)]);
    expect(activateProgramSongLeaf(sequence, 'y')).toBe(true);
    expect(sequence.activeItemId).toBe('group');
    expect(inner.activeItemId).toBe('y');
    expect(inner.startedAt).toBe(NOW + 7);
  });

  it('returns false for unknown leaves and beyond the depth limit', () => {
    const sequence = seq([nested('group', seq([leaf('x')]))]);
    expect(activateProgramSongLeaf(sequence, 'nope')).toBe(false);
    expect(sequence.activeItemId).toBe('group');
    expect(activateProgramSongLeaf(deepChain(10), 'deep')).toBe(false);
    expect(activateProgramSongLeaf(deepChain(8), 'deep')).toBe(true);
  });
});
