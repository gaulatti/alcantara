import { passEndsAfterMs } from './flight-recovery';

describe('passEndsAfterMs', () => {
  const durations = new Map([[5, 30_000]]);

  it('adds the waits and the rest of each song, by the resolver', () => {
    expect(
      passEndsAfterMs(
        [
          { id: 'a', kind: 'playSong', songId: 5 },
          { id: 'b', kind: 'wait', durationMs: 4_000 },
          { id: 'c', kind: 'waitForSongEnd' },
          { id: 'd', kind: 'wait', durationMs: 500 },
        ],
        durations,
      ),
    ).toBe(30_500);
  });

  it('is zero for cues that take no time', () => {
    expect(
      passEndsAfterMs([{ id: 'a', kind: 'scene', sceneId: 1 }], durations),
    ).toBe(0);
  });
});
