import { fillRadioRundown, parseFillerRules } from './radio-rundown-filler';
import type { FlightCue } from './flight.types';
import type { TaggedSong } from './radio-log-generator';
const song = (
  id: number,
  durationMs: number | null,
  artist = String(id),
): TaggedSong => ({
  id,
  durationMs,
  artist,
  asset: { labels: [{ labelId: 'fill', position: id }] },
});
const rules = { labelId: 'fill', artistSeparation: 0 };
const content: FlightCue[] = [
  { id: 'a', kind: 'playSong', songId: 1, clockOffsetSeconds: 0 },
  { id: 'b', kind: 'playSong', songId: 2, clockOffsetSeconds: 60 },
  { id: 'end', kind: 'stopSong', clockOffsetSeconds: 120 },
];
describe('scheduled rundown fillers', () => {
  it('preserves content and fixed times, fills real gaps without repeats, and reports cuts', () => {
    const preview = fillRadioRundown(
      rules,
      content,
      [song(1, 20000), song(2, 30000), song(3, 50000), song(4, 40000)],
      [],
    );
    expect(preview.items.filter((cue) => !cue.isFiller)).toEqual(content);
    expect(
      preview.items.filter((cue) => cue.isFiller).map((cue) => cue.songId),
    ).toEqual([4, 3]);
    expect(preview.items.at(-1)).toMatchObject({
      kind: 'stopSong',
      clockOffsetSeconds: 120,
    });
    expect(preview.warnings).toEqual([expect.stringContaining('cut 20s')]);
  });
  it('replaces only generated fillers when previewed again', () => {
    const songs = [
      song(1, 20000),
      song(2, 30000),
      song(3, 50000),
      song(4, 40000),
    ];
    const first = fillRadioRundown(rules, content, songs, []);
    const again = fillRadioRundown(rules, first.items, songs, []);
    expect(
      again.items.map((cue) => [
        cue.kind,
        cue.songId,
        cue.clockOffsetSeconds,
        cue.isFiller,
      ]),
    ).toEqual(
      first.items.map((cue) => [
        cue.kind,
        cue.songId,
        cue.clockOffsetSeconds,
        cue.isFiller,
      ]),
    );
  });
  it('refuses missing content duration, overrun, and insufficient filler instead of inventing material', () => {
    expect(() =>
      fillRadioRundown(rules, content, [song(1, null), song(2, 30000)], []),
    ).toThrow('duration');
    expect(() =>
      fillRadioRundown(rules, content, [song(1, 61000), song(2, 30000)], []),
    ).toThrow('overruns');
    expect(() =>
      fillRadioRundown(rules, content, [song(1, 20000), song(2, 30000)], []),
    ).toThrow('Not enough');
    expect(() =>
      parseFillerRules({ labelId: 'fill', artistSeparation: '2' }),
    ).toThrow();
  });
  it('requires declared clip duration and preserves explicit silence', () => {
    const cues: FlightCue[] = [
      {
        id: 'clip',
        kind: 'instant',
        instantId: 9,
        clockOffsetSeconds: 0,
        durationMs: 10000,
      },
      { id: 'stop', kind: 'stopSong', clockOffsetSeconds: 60 },
    ];
    const preview = fillRadioRundown(rules, cues, [song(5, 50000)], []);
    expect(preview.items.map((cue) => cue.songId)).toEqual([
      undefined,
      5,
      undefined,
    ]);
    expect(() =>
      fillRadioRundown(
        rules,
        [{ ...cues[0], durationMs: undefined }, cues[1]],
        [song(5, 50000)],
        [],
      ),
    ).toThrow('clip duration');
  });
  it('excludes unknown filler durations visibly and enforces artist separation', () => {
    expect(
      fillRadioRundown(
        rules,
        content,
        [
          song(1, 20000),
          song(2, 30000),
          song(3, 50000),
          song(4, 40000),
          song(5, null),
        ],
        [],
      ).warnings,
    ).toContain('1 tagged songs have no duration and were excluded.');
    expect(() =>
      fillRadioRundown(
        { ...rules, artistSeparation: 1 },
        content,
        [song(1, 20000, 'a'), song(2, 30000, 'a'), song(3, 50000, 'a')],
        [],
      ),
    ).toThrow('Not enough');
  });
});

it('does not invent an hour or append material after the last content event', () => {
  const one: FlightCue[] = [
    {
      id: 'clip',
      kind: 'instant',
      instantId: 9,
      durationMs: 10000,
      clockOffsetSeconds: 0,
    },
  ];
  expect(fillRadioRundown(rules, one, [], []).items).toEqual(one);
});

describe('rundown boundary input and scheduling cases', () => {
  it('requires reviewed content rather than treating generated fillers as content', () => {
    for (const input of [
      [],
      [
        {
          id: 'generated',
          kind: 'playSong',
          songId: 1,
          isFiller: true,
        } as FlightCue,
      ],
    ]) {
      expect(() => fillRadioRundown(rules, input, [song(1, 1000)], [])).toThrow(
        'Add timed content',
      );
    }
  });

  it('preserves contiguous untimed cues and rejects a later fixed start reached too late', () => {
    const contiguous: FlightCue[] = [
      { id: 'first', kind: 'playSong', songId: 1 },
      { id: 'second', kind: 'playSong', songId: 2 },
      { id: 'end', kind: 'stopSong', clockOffsetSeconds: 5 },
    ];
    expect(
      fillRadioRundown(rules, contiguous, [song(1, 2000), song(2, 3000)], [])
        .items,
    ).toEqual(contiguous);
    expect(() =>
      fillRadioRundown(
        rules,
        [
          { id: 'long', kind: 'instant', durationMs: 2000 },
          { id: 'middle', kind: 'stopSong', clockOffsetSeconds: 1 },
        ],
        [],
        [],
      ),
    ).toThrow('overruns');
  });

  it('does not fill explicitly stopped time before a later fixed event', () => {
    const silence: FlightCue[] = [
      { id: 'silence', kind: 'stopSong', clockOffsetSeconds: 0 },
      { id: 'end', kind: 'stopSong', clockOffsetSeconds: 60 },
    ];
    expect(fillRadioRundown(rules, silence, [song(1, 60000)], [])).toEqual({
      items: silence,
      warnings: [],
    });
  });

  it('rejects adjacent reviewed songs by the same normalized artist', () => {
    expect(() =>
      fillRadioRundown(
        { ...rules, artistSeparation: 1 },
        [
          { id: 'one', kind: 'playSong', songId: 1 },
          { id: 'two', kind: 'playSong', songId: 2 },
        ],
        [song(1, 1000, ' Artist '), song(2, 1000, 'artist')],
        [],
      ),
    ).toThrow('Content and fillers violate artist separation');
  });

  it('prefers never-used fillers then least recently used songs with stable ID ordering', () => {
    const cues: FlightCue[] = [
      { id: 'clip', kind: 'instant', durationMs: 1000 },
      { id: 'end', kind: 'stopSong', clockOffsetSeconds: 4 },
    ];
    const songs = [
      song(3, 1000),
      song(2, 1000),
      song(1, 1000),
      { ...song(4, 1000), asset: null },
    ];
    const result = fillRadioRundown(rules, cues, songs, [3, 2]);
    expect(
      result.items.filter((cue) => cue.isFiller).map((cue) => cue.songId),
    ).toEqual([1, 3, 2]);
    expect(result.warnings).toEqual([]);
  });

  it('cuts the shortest eligible song, breaking equal duration ties by song ID and reporting its title', () => {
    const cues: FlightCue[] = [
      { id: 'clip', kind: 'instant', durationMs: 1000 },
      { id: 'end', kind: 'stopSong', clockOffsetSeconds: 2 },
    ];
    const result = fillRadioRundown(
      rules,
      cues,
      [
        song(3, 3000),
        { ...song(2, 2000), title: 'Short fixture' },
        song(1, 2000),
      ],
      [1],
    );
    expect(result.items[1]).toMatchObject({ isFiller: true, songId: 1 });
    expect(result.warnings).toEqual([
      'Filler song #1 will be cut 1s before its end at the fixed boundary.',
    ]);
    const named = fillRadioRundown(
      rules,
      cues,
      [{ ...song(2, 2000), title: 'Short fixture' }, song(3, 3000)],
      [],
    );
    expect(named.warnings).toEqual([
      'Filler Short fixture will be cut 1s before its end at the fixed boundary.',
    ]);
  });

  it('limits filler expansion while reserving a place for the ending boundary', () => {
    const cues: FlightCue[] = [
      { id: 'clip', kind: 'instant', durationMs: 1000 },
      { id: 'end', kind: 'stopSong', clockOffsetSeconds: 120 },
    ];
    expect(() =>
      fillRadioRundown(
        rules,
        cues,
        Array.from({ length: 119 }, (_, i) => song(i + 1, 1000)),
        [],
      ),
    ).toThrow('at most 120 events including its end boundary');
  });

  it('rejects more than 120 reviewed events even when no filler is necessary', () => {
    const cues: FlightCue[] = Array.from({ length: 121 }, (_, i) => ({
      id: `stop-${i}`,
      kind: 'stopSong',
    }));
    expect(() => fillRadioRundown(rules, cues, [], [])).toThrow(
      'at most 120 events',
    );
  });

  it('rejects a content cue scheduled before the beginning of its rundown', () => {
    expect(() =>
      fillRadioRundown(
        rules,
        [{ id: 'negative-start', kind: 'stopSong', clockOffsetSeconds: -1 }],
        [],
        [],
      ),
    ).toThrow('overruns its fixed start');
  });
});
