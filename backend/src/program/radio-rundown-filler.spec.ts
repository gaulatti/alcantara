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
    ).toEqual([4, 3, undefined]);
    expect(preview.items.at(-1)).toMatchObject({
      kind: 'stopSong',
      clockOffsetSeconds: 3600,
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
