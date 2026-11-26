import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  formatOverrun,
  rundownOverrunMs,
  type OverrunCue,
} from './rundown-overrun';

// #788 item 3: the backend's copy of the rundown desk's overrun (frontend rundownTiming and timelineLayout).

const songs = new Map<number, number | null>([
  [1, 240_000],
  [2, 180_000],
  [3, null],
]);

describe('rundownOverrunMs', () => {
  it('counts what runs past the next fixed start, from each fixed start', () => {
    expect(
      rundownOverrunMs(
        [
          { kind: 'playSong', songId: 1, clockOffsetSeconds: 0 },
          { kind: 'playSong', songId: 2 },
          { kind: 'playSong', songId: 1, clockOffsetSeconds: 300 },
          { kind: 'instant', durationMs: 70_000 },
          { kind: 'stopSong', clockOffsetSeconds: 600 },
        ],
        songs,
      ),
    ).toBe(130_000); // 120 s cut at +300 s, then 10 s at +600 s
  });

  it('counts nothing for content that fits, an unknown length, a filler or the last stretch', () => {
    expect(
      rundownOverrunMs(
        [
          { kind: 'playSong', songId: 2, clockOffsetSeconds: 0 },
          { kind: 'playSong', songId: 1, clockOffsetSeconds: 300 },
        ],
        songs,
      ),
    ).toBe(0);
    for (const unknown of [
      { kind: 'playSong', songId: 3 },
      { kind: 'playSong', songId: 99 },
      { kind: 'playSong' },
      { kind: 'instant' },
      { kind: 'instant', durationMs: 0 },
    ])
      expect(
        rundownOverrunMs(
          [
            { kind: 'playSong', songId: 1, clockOffsetSeconds: 0 },
            unknown,
            { kind: 'playSong', songId: 1, clockOffsetSeconds: 60 },
          ],
          songs,
        ),
      ).toBe(0);
    expect(
      rundownOverrunMs(
        [
          { kind: 'playSong', songId: 1, clockOffsetSeconds: 0, isFiller: true },
          { kind: 'playSong', songId: 2, clockOffsetSeconds: 60 },
          { kind: 'playSong', songId: 1 },
        ],
        songs,
      ),
    ).toBe(0);
  });
});

it('writes a length as the desk does', () => {
  expect(formatOverrun(65_000)).toBe('01:05');
  expect(formatOverrun(600_400)).toBe('10:00');
});

// The cases the frontend's rule runs too (frontend/app/utils/rundownOverrun.shared.test.ts): the port cannot drift.
describe('the shared rundown overrun cases', () => {
  const { cases } = JSON.parse(
    readFileSync(
      join(__dirname, '..', '..', '..', 'shared', 'rundown-overrun.cases.json'),
      'utf8',
    ),
  ) as {
    cases: {
      name: string;
      songs: Record<string, number | null>;
      items: OverrunCue[];
      overrunMs: number;
    }[];
  };

  it('has the fixed-start, fit, unknown-length and filler cases', () => {
    expect(cases.length).toBeGreaterThanOrEqual(4);
  });

  it.each(cases.map((one) => [one.name, one] as const))('%s', (_name, one) => {
    const songs = new Map(
      Object.entries(one.songs).map(([id, ms]) => [Number(id), ms]),
    );
    expect(rundownOverrunMs(one.items, songs)).toBe(one.overrunMs);
  });
});
