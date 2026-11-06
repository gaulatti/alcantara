import { BadRequestException } from '@nestjs/common';
import { fillRadioRundown } from './radio-rundown-filler';
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

describe('rundown filler failure and boundary paths', () => {
  it('rejects input that holds only generated fillers', () => {
    const onlyFillers: FlightCue[] = [
      { id: 'f', kind: 'playSong', songId: 1, isFiller: true },
    ];
    expect(() =>
      fillRadioRundown(rules, onlyFillers, [song(1, 1000)], []),
    ).toThrow('Add timed content before filling gaps');
    expect(() => fillRadioRundown(rules, [], [], [])).toThrow(
      BadRequestException,
    );
  });

  it('rejects content that repeats an artist inside the separation window', () => {
    const content: FlightCue[] = [
      { id: 'a', kind: 'playSong', songId: 1, clockOffsetSeconds: 0 },
      { id: 'b', kind: 'playSong', songId: 2 },
    ];
    expect(() =>
      fillRadioRundown(
        { labelId: 'fill', artistSeparation: 1 },
        content,
        [song(1, 1000, 'Same'), song(2, 1000, ' SAME ')],
        [],
      ),
    ).toThrow(
      'Content and fillers violate artist separation. Change the tag, content, or separation rule.',
    );
  });

  it('rejects a fixed start that is already overrun', () => {
    const content: FlightCue[] = [
      { id: 'a', kind: 'stopSong', clockOffsetSeconds: -5 },
    ];
    expect(() => fillRadioRundown(rules, content, [], [])).toThrow(
      'Content at +-5s overruns its fixed start by 5s',
    );
  });

  it('keeps content without a fixed start immediately after the previous event', () => {
    const content: FlightCue[] = [
      { id: 'a', kind: 'playSong', songId: 1, clockOffsetSeconds: 0 },
      { id: 'b', kind: 'instant', durationMs: 5000 },
      { id: 'c', kind: 'stopSong', clockOffsetSeconds: 60 },
    ];
    const result = fillRadioRundown(
      rules,
      content,
      [song(1, 10000), song(9, 45000)],
      [],
    );
    expect(result.items.map((cue) => cue.id)).toEqual([
      'a',
      'b',
      expect.any(String),
      'c',
    ]);
    expect(result.items[2]).toMatchObject({ songId: 9, isFiller: true });
    expect(result.warnings).toEqual([]);
  });

  it('treats a stop before a fixed boundary as intentional silence', () => {
    const content: FlightCue[] = [
      { id: 'a', kind: 'stopSong', clockOffsetSeconds: 0 },
      { id: 'b', kind: 'playSong', songId: 1, clockOffsetSeconds: 600 },
    ];
    const result = fillRadioRundown(
      rules,
      content,
      [song(1, 1000), song(2, 1000)],
      [],
    );
    expect(result.items).toEqual(content);
    expect(result.warnings).toEqual([]);
  });

  it('stops filling once the rundown reaches 120 events', () => {
    const pool = Array.from({ length: 150 }, (_, i) => song(i + 1, 1000));
    const content: FlightCue[] = [
      { id: 'a', kind: 'instant', durationMs: 1000, clockOffsetSeconds: 0 },
      { id: 'b', kind: 'stopSong', clockOffsetSeconds: 200 },
    ];
    expect(() => fillRadioRundown(rules, content, pool, [])).toThrow(
      'A filled rundown can contain at most 120 events including its end boundary',
    );
  });

  it('rejects content that alone exceeds 120 events', () => {
    const content: FlightCue[] = Array.from({ length: 121 }, (_, i) => ({
      id: `c${i}`,
      kind: 'stopSong' as const,
    }));
    expect(() => fillRadioRundown(rules, content, [], [])).toThrow(
      'A filled rundown can contain at most 120 events',
    );
  });
});
