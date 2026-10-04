import {
  generateRadioLog,
  parseRadioLogRules,
  type TaggedSong,
} from './radio-log-generator';

const labels = [
  { id: 'hits', name: 'Hits' },
  { id: 'gold', name: 'Gold' },
];
const song = (id: number, artist: string, tags = ['hits']): TaggedSong => ({
  id,
  artist,
  durationMs: 180000,
  asset: { labels: tags.map((labelId) => ({ labelId, position: id })) },
});

describe('tagged radio clock generation', () => {
  it('resolves blocks into unique catalog IDs, least recently scheduled first, with fixed starts only at block boundaries', () => {
    const rules = parseRadioLogRules({
      slots: [
        { labelId: 'hits', count: 2, clockOffsetSeconds: 0 },
        { labelId: 'gold', count: 1, clockOffsetSeconds: 1800 },
      ],
      artistSeparation: 1,
    });
    const cues = generateRadioLog(
      rules,
      [song(1, 'A'), song(2, 'B'), song(3, 'C', ['gold'])],
      labels,
      [1],
    );
    expect(cues.map((cue) => cue.songId)).toEqual([2, 1, 3]);
    expect(cues.map((cue) => cue.clockOffsetSeconds)).toEqual([
      0,
      undefined,
      1800,
    ]);
    expect(new Set(cues.map((cue) => cue.id)).size).toBe(3);
    expect(cues.every((cue) => !('labelId' in cue))).toBe(true);
  });
  it('does not repeat a track across overlapping tags or silently relax artist separation', () => {
    const rules = parseRadioLogRules({
      slots: [
        { labelId: 'hits', count: 1, clockOffsetSeconds: 0 },
        { labelId: 'gold', count: 1 },
      ],
      artistSeparation: 1,
    });
    expect(() =>
      generateRadioLog(
        rules,
        [song(1, ' Artist ', ['hits', 'gold']), song(2, 'artist', ['gold'])],
        labels,
        [],
      ),
    ).toThrow('artist separation');
    expect(
      generateRadioLog(
        { ...rules, artistSeparation: 0 },
        [song(1, 'A', ['hits', 'gold']), song(2, 'A', ['gold'])],
        labels,
        [],
      ).map((cue) => cue.songId),
    ).toEqual([1, 2]);
  });
  it.each([
    { slots: [], artistSeparation: 0 },
    {
      slots: [{ labelId: 'hits', count: '2', clockOffsetSeconds: 0 }],
      artistSeparation: 0,
    },
    {
      slots: [{ labelId: 'hits', count: 121, clockOffsetSeconds: 0 }],
      artistSeparation: 0,
    },
    { slots: [{ labelId: 'hits', count: 1 }], artistSeparation: 0 },
    {
      slots: [{ labelId: 'hits', count: 1, clockOffsetSeconds: 0 }],
      artistSeparation: -1,
    },
    {
      slots: [
        { labelId: 'hits', count: 1, clockOffsetSeconds: 0 },
        { labelId: 'hits', count: 1, clockOffsetSeconds: -1 },
      ],
      artistSeparation: 0,
    },
  ])('rejects invalid rules without creating a partial log: %j', (rules) => {
    expect(() => parseRadioLogRules(rules)).toThrow();
  });
  it('reports a deleted tag explicitly', () => {
    expect(() =>
      generateRadioLog(
        {
          slots: [{ labelId: 'gone', count: 1, clockOffsetSeconds: 0 }],
          artistSeparation: 0,
        },
        [],
        labels,
        [],
      ),
    ).toThrow('tag no longer exists');
  });
});
