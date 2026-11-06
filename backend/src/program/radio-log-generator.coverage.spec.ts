import { BadRequestException } from '@nestjs/common';
import {
  generateRadioLog,
  parseRadioLogRules,
  type TaggedSong,
} from './radio-log-generator';

describe('radio log generator boundary coverage', () => {
  it('rejects logs whose blocks together exceed 120 songs', () => {
    const attempt = () =>
      parseRadioLogRules({
        slots: [
          { labelId: 'hits', count: 100, clockOffsetSeconds: 0 },
          { labelId: 'hits', count: 100, clockOffsetSeconds: 10 },
        ],
        artistSeparation: 0,
      });
    expect(attempt).toThrow(BadRequestException);
    expect(attempt).toThrow('A log can contain at most 120 songs');
  });

  it('breaks equal tag positions by ascending song id', () => {
    const tied = (id: number): TaggedSong => ({
      id,
      artist: `artist ${id}`,
      durationMs: 1000,
      asset: { labels: [{ labelId: 'hits', position: 7 }] },
    });
    const cues = generateRadioLog(
      {
        slots: [{ labelId: 'hits', count: 3, clockOffsetSeconds: 0 }],
        artistSeparation: 0,
      },
      [tied(3), tied(1), tied(2)],
      [{ id: 'hits', name: 'Hits' }],
      [],
    );
    expect(cues.map((cue) => cue.songId)).toEqual([1, 2, 3]);
    expect(cues[0].clockOffsetSeconds).toBe(0);
    expect(cues[1].clockOffsetSeconds).toBeUndefined();
  });
});
