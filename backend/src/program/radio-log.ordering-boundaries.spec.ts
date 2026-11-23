import { generateRadioLog, parseRadioLogRules } from './radio-log-generator';

describe('radio clock whole-log limits and deterministic ordering', () => {
  it('rejects an aggregate over 120 songs even when each block is within its own limit', () => {
    expect(() =>
      parseRadioLogRules({
        artistSeparation: 0,
        slots: [
          { labelId: 'music', count: 120, clockOffsetSeconds: 0 },
          { labelId: 'music', count: 1 },
        ],
      }),
    ).toThrow('A log can contain at most 120 songs');
  });

  it('uses catalog identity to break equal tag-position and play-history ties regardless of input order', () => {
    const songs = [9, 2, 5].map((id) => ({
      id,
      artist: `Artist ${id}`,
      durationMs: 1000,
      asset: { labels: [{ labelId: 'music', position: 0 }] },
    }));
    const rules = parseRadioLogRules({
      artistSeparation: 0,
      slots: [{ labelId: 'music', count: 3, clockOffsetSeconds: 0 }],
    });
    const generate = (input: typeof songs) =>
      generateRadioLog(rules, input, [{ id: 'music', name: 'Music' }], []).map(
        (cue) => cue.songId,
      );
    expect(generate(songs)).toEqual([2, 5, 9]);
    expect(generate([...songs].reverse())).toEqual([2, 5, 9]);
  });
});
