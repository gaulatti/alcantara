import {
  activateProgramSongLeaf,
  advanceProgramSongSequence,
  collectHighRotationProgramSongLeaves,
  collectProgramSongLeaves,
  findUniqueProgramSongLeafByAudioUrl,
  findUniqueProgramSongLeafById,
  getProgramSongSequenceSelectedItemId,
  normalizeProgramSongSequence,
  ProgramSongSequence,
  ProgramSongSequenceItem,
  ProgramSongSequenceLeafItem,
  resolveProgramSongLeaf,
} from './song-sequence.utils';

const leaf = (
  id: string,
  durationMs?: number,
): ProgramSongSequenceLeafItem => ({
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
  activeItemId: items[0]?.id ?? null,
  intervalMs: 4000,
  loop: true,
  startedAt: 1000,
  ...overrides,
});

const nested = (
  id: string,
  child: ProgramSongSequence,
): ProgramSongSequenceItem => ({
  kind: 'sequence',
  id,
  label: id,
  sequence: child,
});

describe('program song sequence input boundaries', () => {
  afterEach(() => jest.restoreAllMocks());

  it.each([null, undefined, false, 7, 'playlist', []])(
    'rejects a non-record sequence: %p',
    (value) => expect(normalizeProgramSongSequence(value)).toBeNull(),
  );

  it('filters malformed items and nested sequences while retaining a usable default shape', () => {
    jest.spyOn(Date, 'now').mockReturnValue(1234);
    expect(normalizeProgramSongSequence({ items: 'invalid' })).toEqual({
      mode: 'autoplay',
      items: [],
      activeItemId: null,
      intervalMs: 4000,
      loop: true,
      startedAt: 1234,
    });
    const parsed = normalizeProgramSongSequence({
      items: [null, false, [], { kind: 'sequence', sequence: null }, {}],
    });
    expect(parsed?.items).toHaveLength(1);
    expect(parsed?.items[0]).toMatchObject({
      id: `song_${(1234).toString(36)}`,
      kind: 'preset',
      artist: '',
      title: '',
      coverUrl: '',
    });
    expect(parsed?.activeItemId).toBe(parsed?.items[0].id);
  });

  it('trims media metadata and preserves both textual and numeric EarOne identifiers', () => {
    const parsed = normalizeProgramSongSequence({
      mode: 'manual',
      activeItemId: 'song',
      intervalMs: 500.9,
      startedAt: 0,
      loop: false,
      items: [
        {
          id: 'song',
          artist: ' Artist ',
          title: ' Song ',
          coverUrl: ' cover ',
          audioUrl: ' audio ',
          songId: 3,
          highRotation: true,
          durationMs: 501.6,
          earoneSongId: ' 001 ',
          earoneRank: ' 9 ',
          earoneSpins: ' 21 ',
        },
        { id: 'numeric', earoneSongId: 0, earoneSpins: 12 },
      ],
    });
    expect(parsed).toMatchObject({
      mode: 'manual',
      activeItemId: 'song',
      intervalMs: 500,
      startedAt: 0,
      loop: false,
    });
    expect(parsed?.items[0]).toMatchObject({
      artist: 'Artist',
      title: 'Song',
      coverUrl: 'cover',
      audioUrl: 'audio',
      songId: 3,
      highRotation: true,
      durationMs: 502,
      earoneSongId: '001',
      earoneRank: '9',
      earoneSpins: '21',
    });
    expect(parsed?.items[1]).toMatchObject({
      earoneSongId: '0',
      earoneSpins: '12',
    });
  });

  it.each([undefined, '', ' ', false, NaN, Infinity, -1, 0])(
    'drops invalid optional metadata rather than inventing playable media: %p',
    (value) => {
      const parsed = normalizeProgramSongSequence({
        items: [
          {
            id: '',
            artist: value,
            title: value,
            coverUrl: value,
            audioUrl: value,
            songId: value,
            durationMs: value,
            earoneSongId: value,
            earoneRank: value,
            earoneSpins: value,
            highRotation: value,
          },
        ],
      });
      const item = parsed?.items[0];
      expect(item).toMatchObject({ kind: 'preset', highRotation: false });
      expect(item && 'songId' in item && item.songId).toBeUndefined();
      expect(item && 'durationMs' in item && item.durationMs).toBeUndefined();
      expect(item && 'audioUrl' in item && item.audioUrl).toBeUndefined();
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        expect(
          item && 'earoneSongId' in item && item.earoneSongId,
        ).toBeUndefined();
        expect(
          item && 'earoneSpins' in item && item.earoneSpins,
        ).toBeUndefined();
      }
    },
  );

  it.each([499, NaN, Infinity, '500'])(
    'defaults invalid interval %p and start timestamp',
    (intervalMs) => {
      jest.spyOn(Date, 'now').mockReturnValue(1234);
      const parsed = normalizeProgramSongSequence({
        intervalMs,
        startedAt: NaN,
        activeItemId: 'missing',
        items: [{ id: 'first', songId: 1.5 }],
        loop: 0,
      });
      expect(parsed).toMatchObject({
        activeItemId: 'first',
        intervalMs: 4000,
        startedAt: 1234,
        loop: false,
      });
      expect(parsed?.items[0]).toHaveProperty('songId', undefined);
    },
  );

  it('preserves an explicitly stopped cursor and supplies nested identifiers and labels', () => {
    jest.spyOn(Date, 'now').mockReturnValue(1234);
    const parsed = normalizeProgramSongSequence({
      activeItemId: null,
      items: [{ kind: 'sequence', id: '', label: ' ', sequence: {} }],
    });
    expect(parsed?.activeItemId).toBeNull();
    expect(parsed?.items[0]).toMatchObject({
      id: `sequence_${(1234).toString(36)}`,
      label: 'Nested Sequence',
      sequence: { items: [], activeItemId: null },
    });
  });

  it('accepts eight nested levels and discards descendants beyond the depth limit', () => {
    let raw: unknown = { items: [{ id: 'deepest' }] };
    for (let index = 0; index < 8; index += 1) {
      raw = {
        items: [{ id: `level-${index}`, kind: 'sequence', sequence: raw }],
      };
    }
    expect(
      collectProgramSongLeaves(normalizeProgramSongSequence(raw)).map(
        (item) => item.id,
      ),
    ).toEqual(['deepest']);
    raw = { items: [{ id: 'too-deep', kind: 'sequence', sequence: raw }] };
    const parsed = normalizeProgramSongSequence(raw);
    expect(parsed).not.toBeNull();
    expect(collectProgramSongLeaves(parsed)).toEqual([]);
    expect(normalizeProgramSongSequence({}, 9)).toBeNull();
  });
});

describe('program song sequence elapsed selection', () => {
  it('holds manual choices, stops null cursors and resolves stale cursors to the first item', () => {
    const items = [leaf('one', 100), leaf('two', 200)];
    expect(
      getProgramSongSequenceSelectedItemId(
        sequence(items, { mode: 'manual', activeItemId: 'two' }),
        99999,
      ),
    ).toBe('two');
    expect(
      getProgramSongSequenceSelectedItemId(
        sequence(items, { activeItemId: null }),
        1000,
      ),
    ).toBeNull();
    expect(
      getProgramSongSequenceSelectedItemId(
        sequence(items, { activeItemId: 'stale' }),
        1000,
      ),
    ).toBe('one');
    expect(getProgramSongSequenceSelectedItemId(sequence([]))).toBeNull();
  });

  it('uses individual track durations at exact boundaries and wraps from the active base', () => {
    const playlist = sequence(
      [leaf('one', 100), leaf('two', 200), leaf('three', 300)],
      { activeItemId: 'two' },
    );
    const cases: [number, string][] = [
      [-1, 'two'],
      [0, 'two'],
      [199, 'two'],
      [200, 'three'],
      [499, 'three'],
      [500, 'one'],
      [599, 'one'],
      [600, 'two'],
      [1400, 'three'],
    ];
    for (const [elapsed, expected] of cases) {
      expect(
        getProgramSongSequenceSelectedItemId(playlist, 1000 + elapsed),
      ).toBe(expected);
    }
  });

  it('waits on the first unknown duration instead of guessing when looping', () => {
    const playlist = sequence([
      leaf('one', 100),
      leaf('two'),
      leaf('three', 200),
    ]);
    expect(getProgramSongSequenceSelectedItemId(playlist, 1099)).toBe('one');
    expect(getProgramSongSequenceSelectedItemId(playlist, 1100)).toBe('two');
    expect(getProgramSongSequenceSelectedItemId(playlist, 99999)).toBe('two');
  });

  it('holds the final non-looping item and does not advance past an unknown duration', () => {
    const playlist = sequence(
      [leaf('one', 100), leaf('two', 200), leaf('three', 300)],
      { loop: false },
    );
    expect(getProgramSongSequenceSelectedItemId(playlist, 1099)).toBe('one');
    expect(getProgramSongSequenceSelectedItemId(playlist, 1100)).toBe('two');
    expect(getProgramSongSequenceSelectedItemId(playlist, 99999)).toBe('three');
    expect(
      getProgramSongSequenceSelectedItemId(
        sequence([leaf('unknown'), leaf('later', 10)], { loop: false }),
        99999,
      ),
    ).toBe('unknown');
  });

  it.each([0, -1, NaN, Infinity])(
    'does not infer elapsed playback from an invalid duration %p',
    (durationMs) => {
      expect(
        getProgramSongSequenceSelectedItemId(
          sequence([leaf('unknown', durationMs), leaf('later', 10)]),
          99999,
        ),
      ).toBe('unknown');
    },
  );
});

describe('program song sequence authoritative progression', () => {
  beforeEach(() => jest.spyOn(Date, 'now').mockReturnValue(5000));
  afterEach(() => jest.restoreAllMocks());

  it('advances an authoritative leaf inside a nested sequence before advancing its parent', () => {
    const child = sequence([leaf('one'), leaf('two')], { loop: false });
    const playlist = sequence([nested('block', child), leaf('after')]);
    expect(advanceProgramSongSequence(playlist, ' one ')).toBe(true);
    expect(child).toMatchObject({ activeItemId: 'two', startedAt: 5000 });
    expect(playlist.activeItemId).toBe('block');
    expect(advanceProgramSongSequence(playlist, 'two')).toBe(true);
    expect(child.activeItemId).toBeNull();
    expect(playlist).toMatchObject({ activeItemId: 'after', startedAt: 5000 });
  });

  it('resets the full first nested path when wrapping or entering a nested successor', () => {
    const innermost = sequence([leaf('first'), leaf('second')], {
      activeItemId: 'second',
    });
    const child = sequence([nested('inner', innermost), leaf('unused')], {
      activeItemId: 'unused',
    });
    const playlist = sequence([leaf('before'), nested('block', child)]);
    expect(advanceProgramSongSequence(playlist, 'before')).toBe(true);
    expect(playlist.activeItemId).toBe('block');
    expect(child.activeItemId).toBe('inner');
    expect(innermost.activeItemId).toBe('first');
    expect(advanceProgramSongSequence(playlist, 'second')).toBe(true);
    expect(innermost.activeItemId).toBe('first');
  });

  it('uses the current nested leaf when the caller has no authoritative identity', () => {
    const child = sequence([leaf('one'), leaf('two')], { loop: false });
    const playlist = sequence([nested('block', child), leaf('after')]);
    expect(advanceProgramSongSequence(playlist)).toBe(true);
    expect(child.activeItemId).toBe('two');
    expect(advanceProgramSongSequence(playlist, 'missing')).toBe(true);
    expect(playlist.activeItemId).toBe('after');
  });

  it('recovers a stale looped cursor but preserves stopped non-looping and empty sequences', () => {
    const playlist = sequence([nested('empty', sequence([])), leaf('later')], {
      activeItemId: 'stale',
    });
    expect(advanceProgramSongSequence(playlist, 'unknown')).toBe(true);
    expect(playlist.activeItemId).toBe('empty');
    expect(advanceProgramSongSequence(playlist, '')).toBe(true);
    expect(playlist.activeItemId).toBe('later');
    expect(advanceProgramSongSequence(sequence([]))).toBe(false);
    expect(
      advanceProgramSongSequence(
        sequence([leaf('one')], { loop: false, activeItemId: null }),
      ),
    ).toBe(false);
  });

  it('supports direct next/wrap/stop without a supplied leaf ID', () => {
    const playlist = sequence([leaf('one'), leaf('two')]);
    expect(advanceProgramSongSequence(playlist)).toBe(true);
    expect(playlist.activeItemId).toBe('two');
    expect(advanceProgramSongSequence(playlist)).toBe(true);
    expect(playlist.activeItemId).toBe('one');
    playlist.loop = false;
    expect(advanceProgramSongSequence(playlist)).toBe(true);
    expect(advanceProgramSongSequence(playlist)).toBe(false);
    expect(playlist.activeItemId).toBeNull();
  });

  it('enters and resets a nested next item when advancing the current cursor', () => {
    const child = sequence([leaf('first'), leaf('second')], {
      activeItemId: 'second',
    });
    const playlist = sequence([leaf('one'), nested('block', child)], {
      loop: false,
    });
    expect(advanceProgramSongSequence(playlist)).toBe(true);
    expect(playlist.activeItemId).toBe('block');
    expect(child.activeItemId).toBe('first');
    const finalEmpty = sequence([nested('empty', sequence([]))], {
      loop: false,
    });
    expect(advanceProgramSongSequence(finalEmpty)).toBe(false);
    expect(finalEmpty.activeItemId).toBeNull();
  });
});

describe('program song sequence tree traversal', () => {
  afterEach(() => jest.restoreAllMocks());

  it('collects nested leaves in order with full labels and high rotation eligibility', () => {
    const favorite = {
      ...leaf('favorite'),
      title: '',
      highRotation: true,
      audioUrl: 'media',
    };
    const playlist = sequence([
      leaf('before'),
      nested('hour', sequence([favorite])),
      leaf('after'),
    ]);
    expect(
      collectProgramSongLeaves(playlist).map((item) => [
        item.id,
        item.activePathLabels,
      ]),
    ).toEqual([
      ['before', ['before']],
      ['favorite', ['hour', 'Song Preset']],
      ['after', ['after']],
    ]);
    expect(
      collectHighRotationProgramSongLeaves(playlist).map((item) => item.id),
    ).toEqual(['favorite']);
    expect(
      resolveProgramSongLeaf(
        sequence([nested('hour', sequence([favorite]))]),
        1000,
      ),
    ).toMatchObject({
      id: 'favorite',
      activePathLabels: ['hour', 'Song Preset'],
    });
    expect(findUniqueProgramSongLeafById(playlist, ' favorite ')).toMatchObject(
      { activePathLabels: ['hour', 'Song Preset'] },
    );
    expect(
      findUniqueProgramSongLeafByAudioUrl(playlist, ' media '),
    ).toMatchObject({ activePathLabels: ['hour', 'Song Preset'] });
  });

  it('activates the complete ancestor path and leaves unmatched trees unchanged', () => {
    jest.spyOn(Date, 'now').mockReturnValue(9000);
    const child = sequence([leaf('one'), leaf('target')]);
    const playlist = sequence([
      leaf('before'),
      nested('empty', sequence([])),
      nested('hour', child),
    ]);
    expect(activateProgramSongLeaf(playlist, 'absent')).toBe(false);
    expect(playlist.activeItemId).toBe('before');
    expect(activateProgramSongLeaf(playlist, 'target')).toBe(true);
    expect(playlist).toMatchObject({ activeItemId: 'hour', startedAt: 9000 });
    expect(child).toMatchObject({ activeItemId: 'target', startedAt: 9000 });
  });

  it('fails closed for duplicate identifiers and URLs across nested blocks', () => {
    const item = { ...leaf('duplicate'), title: '', audioUrl: 'same' };
    const playlist = sequence([
      item,
      nested('two', sequence([item])),
      nested('three', sequence([item])),
    ]);
    expect(findUniqueProgramSongLeafById(playlist, 'duplicate')).toBeNull();
    expect(findUniqueProgramSongLeafByAudioUrl(playlist, 'same')).toBeNull();
    expect(findUniqueProgramSongLeafByAudioUrl(playlist, 'missing')).toBeNull();
  });

  it('returns empty results for missing trees, empty identities and stopped selection', () => {
    expect(collectProgramSongLeaves(null)).toEqual([]);
    expect(collectHighRotationProgramSongLeaves(null)).toEqual([]);
    expect(resolveProgramSongLeaf(null)).toBeNull();
    expect(resolveProgramSongLeaf(sequence([]))).toBeNull();
    expect(findUniqueProgramSongLeafById(null, 'id')).toBeNull();
    expect(findUniqueProgramSongLeafByAudioUrl(null, 'url')).toBeNull();
    expect(
      findUniqueProgramSongLeafById(sequence([leaf('one')]), ' '),
    ).toBeNull();
    expect(
      findUniqueProgramSongLeafByAudioUrl(sequence([leaf('one')]), ' '),
    ).toBeNull();
  });

  it('bounds recursive resolution, lookup, activation and collection of directly constructed trees', () => {
    let tree = sequence([{ ...leaf('deep'), audioUrl: 'deep-url' }]);
    for (let index = 0; index < 9; index += 1)
      tree = sequence([nested(`level-${index}`, tree)]);
    expect(resolveProgramSongLeaf(tree, 1000)).toBeNull();
    expect(collectProgramSongLeaves(tree)).toEqual([]);
    expect(findUniqueProgramSongLeafById(tree, 'deep')).toBeNull();
    expect(findUniqueProgramSongLeafByAudioUrl(tree, 'deep-url')).toBeNull();
    expect(activateProgramSongLeaf(tree, 'deep')).toBe(false);
  });
});

it('retains a concrete playable selection when accepted finite numeric timing values overflow aggregate arithmetic', () => {
  const normalized = normalizeProgramSongSequence({
    mode: 'autoplay',
    activeItemId: 'one',
    loop: true,
    startedAt: -Number.MAX_VALUE,
    items: ['one', 'two'].map((id) => ({
      kind: 'preset',
      id,
      artist: 'Artist',
      title: id,
      coverUrl: '',
      audioUrl: `https://media.example/${id}.mp3`,
      durationMs: Number.MAX_VALUE,
    })),
  });
  if (!normalized) throw new Error('Valid finite sequence was rejected');
  expect(Number.isFinite(normalized.startedAt)).toBe(true);
  expect(
    normalized.items.every(
      (item) => item.kind === 'preset' && Number.isFinite(item.durationMs),
    ),
  ).toBe(true);
  expect(resolveProgramSongLeaf(normalized, Number.MAX_VALUE)).toMatchObject({
    id: 'one',
    audioUrl: 'https://media.example/one.mp3',
  });
});
