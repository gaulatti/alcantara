import { Logger } from '@nestjs/common';
import type { PalazzoPlaybackState } from './palazzo-contract';
import {
  PROGRAM_BUS_OVERLAP_ALLOWANCE_MS,
  ProgramBusOverlapDetector,
} from './program-bus-overlap.detector';
import { RadioMetricsService } from './radio-metrics.service';

// gaulatti/alcantara#242: two sources on a radio program's bus past the allowance are raised (metric, warning,
// as-run review flag) while normal song changes and spot changes stay quiet. Detection only: the detector holds
// Prisma for the as-run flag and the radio metrics, nothing else.

const P = 'fixture.fm';
const started = (id: string) => ({
  type: 'track.started',
  data: { playbackRequestId: id },
});
const ended = (id: string) => ({
  type: 'track.ended',
  data: { playbackRequestId: id },
});
const instantStarted = (id: string) => ({
  type: 'instant.started',
  data: { playbackId: id },
});
const instantEnded = (id: string) => ({
  type: 'instant.ended',
  data: { playbackId: id },
});

function setup(updateMany = jest.fn(async () => ({ count: 1 }))) {
  const metrics = new RadioMetricsService();
  const prisma = { asRunRecord: { updateMany } };
  const detector = new ProgramBusOverlapDetector(prisma as never, metrics);
  const warn = jest
    .spyOn(Logger.prototype, 'warn')
    .mockImplementation(() => undefined);
  return { detector, metrics, updateMany, warn };
}

function samples(metrics: RadioMetricsService): string[] {
  return metrics
    .render()
    .split('\n')
    .filter((line) => line.startsWith('alcantara_program_bus_'));
}

const sample = (metrics: RadioMetricsService, series: string) =>
  Number(
    samples(metrics)
      .find((line) => line.split(' ')[0] === series)
      ?.split(' ')[1],
  );

async function advance(ms: number) {
  jest.advanceTimersByTime(ms);
  await Promise.resolve();
  await Promise.resolve();
}

describe('ProgramBusOverlapDetector', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('replays the 2026-11-21 08:10Z shape: a spot under a commanded song, then two songs, each raised once', async () => {
    const { detector, metrics, updateMany, warn } = setup();
    detector.observe(P, started('836'));
    detector.observe(P, ended('836'));
    detector.observe(P, instantStarted('spot-1'), true);
    await advance(2_100);
    detector.observe(P, started('547')); // the command, under the spot
    await advance(PROGRAM_BUS_OVERLAP_ALLOWANCE_MS);
    expect(
      sample(metrics, 'alcantara_program_bus_overlaps_total{kind="spot_song"}'),
    ).toBe(1);
    expect(
      sample(metrics, 'alcantara_program_bus_overlap_active{kind="spot_song"}'),
    ).toBe(1);
    expect(updateMany).toHaveBeenLastCalledWith({
      where: {
        programId: P,
        playbackRequestId: '547',
        state: 'started',
        reviewFlag: null,
      },
      data: { reviewFlag: 'overlap' },
    });
    await advance(4_000);
    detector.observe(P, instantEnded('spot-1')); // ~7 s after the command
    expect(
      sample(metrics, 'alcantara_program_bus_overlap_active{kind="spot_song"}'),
    ).toBe(0);

    await advance(1_000);
    detector.observe(P, started('127')); // the announced song, under the commanded one
    await advance(PROGRAM_BUS_OVERLAP_ALLOWANCE_MS - 1);
    expect(
      sample(metrics, 'alcantara_program_bus_overlaps_total{kind="song_song"}'),
    ).toBe(0);
    await advance(1);
    expect(
      sample(metrics, 'alcantara_program_bus_overlaps_total{kind="song_song"}'),
    ).toBe(1);
    expect(
      sample(metrics, 'alcantara_program_bus_overlap_active{kind="song_song"}'),
    ).toBe(1);
    expect(updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ playbackRequestId: '127' }),
      }),
    );
    expect(warn).toHaveBeenCalledWith(
      `Two songs on air together on ${P} for over 3 s: 547, 127`,
    );

    await advance(207_000);
    detector.observe(P, ended('547'));
    detector.observe(P, ended('127'));
    expect(
      sample(metrics, 'alcantara_program_bus_overlaps_total{kind="song_song"}'),
    ).toBe(1);
    expect(
      sample(metrics, 'alcantara_program_bus_overlap_active{kind="song_song"}'),
    ).toBe(0);
    expect(
      sample(
        metrics,
        'alcantara_program_bus_overlap_flags_total{result="flagged"}',
      ),
    ).toBe(2);
  });

  it('stays quiet through normal song changes in either event order, and through a spot change', async () => {
    const { detector, metrics, updateMany } = setup();
    detector.observe(P, started('a'));
    detector.observe(P, ended('a'));
    detector.observe(P, started('b')); // back to back, end first
    await advance(1_000);
    detector.observe(P, started('c')); // next start first, end 100 ms later
    await advance(100);
    detector.observe(P, ended('b'));
    detector.observe(P, ended('c'));
    detector.observe(P, instantStarted('spot'), true); // spot between songs
    await advance(9_000);
    detector.observe(P, instantEnded('spot'));
    detector.observe(P, started('d'));
    await advance(60_000);
    expect(updateMany).not.toHaveBeenCalled();
    expect(
      sample(metrics, 'alcantara_program_bus_overlaps_total{kind="song_song"}'),
    ).toBe(0);
    expect(
      sample(metrics, 'alcantara_program_bus_overlaps_total{kind="spot_song"}'),
    ).toBe(0);
  });

  it('stays quiet on the 2026-11-23 as-run artifacts: an end for a request never seen to start closes the oldest song', async () => {
    const { detector, updateMany } = setup();
    detector.observe(P, started('4537745a'));
    await advance(300_000);
    detector.observe(P, ended('9a245047')); // the end arrives under another id
    detector.observe(P, started('4f25c5ce'));
    await advance(60_000);
    detector.observe(P, ended('unknown-too'));
    detector.observe(P, ended('nothing-open')); // an end with nothing open is ignored
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('ignores an operator cartwall instant over a song, an intro, and an instant end that is not the spot', async () => {
    const { detector, updateMany } = setup();
    detector.observe(P, started('song'));
    detector.observe(P, instantStarted('cartwall'), false);
    detector.observe(P, {
      type: 'intro.started',
      data: { playbackId: 'intro' },
    });
    detector.observe(P, instantEnded('cartwall'));
    await advance(60_000);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('restarts from a snapshot or a reset without raising, and closes a raised overlap on the gauge', async () => {
    const { detector, metrics, updateMany } = setup();
    detector.observe(P, started('a'));
    detector.observe(P, started('b'));
    await advance(1_000);
    detector.snapshot(P, {
      status: 'playing',
      track: { playbackRequestId: 'b' },
    } as PalazzoPlaybackState);
    await advance(60_000);
    expect(updateMany).not.toHaveBeenCalled();

    detector.observe(P, started('c'));
    await advance(PROGRAM_BUS_OVERLAP_ALLOWANCE_MS);
    expect(
      sample(metrics, 'alcantara_program_bus_overlap_active{kind="song_song"}'),
    ).toBe(1);
    detector.reset(P);
    expect(
      sample(metrics, 'alcantara_program_bus_overlap_active{kind="song_song"}'),
    ).toBe(0);
    detector.reset(P); // nothing left to reset

    detector.snapshot(P, {
      status: 'idle',
      track: null,
    } as PalazzoPlaybackState);
    detector.observe(P, started('d'));
    await advance(60_000);
    expect(
      sample(metrics, 'alcantara_program_bus_overlaps_total{kind="song_song"}'),
    ).toBe(1);
  });

  it('counts one overlap while it goes on, however many sources join it', async () => {
    const { detector, metrics } = setup();
    detector.observe(P, started('a'));
    detector.observe(P, started('b'));
    await advance(1_000);
    detector.observe(P, started('c')); // a third song joins the overlap being timed
    await advance(PROGRAM_BUS_OVERLAP_ALLOWANCE_MS);
    detector.observe(P, ended('a')); // b and c are still on air together
    await advance(60_000);
    expect(
      sample(metrics, 'alcantara_program_bus_overlaps_total{kind="song_song"}'),
    ).toBe(1);
    expect(
      sample(metrics, 'alcantara_program_bus_overlap_active{kind="song_song"}'),
    ).toBe(1);
  });

  it('clears every pending overlap when the module stops', async () => {
    const { detector, updateMany } = setup();
    detector.observe(P, started('a'));
    detector.observe(P, started('b'));
    detector.observe('other.fm', started('x'));
    detector.onModuleDestroy();
    await advance(60_000);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('counts a missing or failed as-run flag, and never throws', async () => {
    const missing = setup(jest.fn(async () => ({ count: 0 })));
    missing.detector.observe(P, started('a'));
    missing.detector.observe(P, started('b'));
    await advance(PROGRAM_BUS_OVERLAP_ALLOWANCE_MS);
    expect(
      sample(
        missing.metrics,
        'alcantara_program_bus_overlap_flags_total{result="missing"}',
      ),
    ).toBe(1);
    jest.restoreAllMocks();

    const failing = setup(jest.fn(() => Promise.reject(new Error('db down'))));
    failing.detector.observe(P, started('a'));
    failing.detector.observe(P, instantStarted('spot'), true);
    await advance(PROGRAM_BUS_OVERLAP_ALLOWANCE_MS);
    expect(
      sample(
        failing.metrics,
        'alcantara_program_bus_overlap_flags_total{result="failed"}',
      ),
    ).toBe(1);
    expect(failing.warn).toHaveBeenCalledWith(
      `A spot and a song on air together on ${P} for over 3 s: spot spot, song a`,
    );
    expect(failing.warn).toHaveBeenCalledWith(
      `As-run overlap flag for a on ${P} was not stored: db down`,
    );
    jest.restoreAllMocks();

    const odd = setup(jest.fn(() => Promise.reject('not an error')));
    odd.detector.observe(P, started('a'));
    odd.detector.observe(P, started('b'));
    await advance(PROGRAM_BUS_OVERLAP_ALLOWANCE_MS);
    expect(odd.warn).toHaveBeenCalledWith(
      `As-run overlap flag for b on ${P} was not stored: unknown error`,
    );
  });

  it('skips a malformed event with a warning instead of throwing into the telemetry path', () => {
    const { detector, warn } = setup();
    expect(() =>
      detector.observe(P, { type: 'track.started' } as never),
    ).not.toThrow();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(
        `Program bus overlap check skipped an event on ${P}:`,
      ),
    );
    const thrower = {
      type: 'track.ended',
      get data(): never {
        throw 'not an error';
      },
    };
    detector.observe(P, thrower as never);
    expect(warn).toHaveBeenLastCalledWith(
      `Program bus overlap check skipped an event on ${P}: unknown error`,
    );
  });

  it('exposes bounded labels only', () => {
    const { metrics } = setup();
    metrics.recordProgramBusOverlap('song_song');
    metrics.setProgramBusOverlapActive('spot_song', -1);
    expect(samples(metrics).sort()).toEqual([
      'alcantara_program_bus_overlap_active{kind="song_song"} 0',
      'alcantara_program_bus_overlap_active{kind="spot_song"} 0',
      'alcantara_program_bus_overlap_flags_total{result="failed"} 0',
      'alcantara_program_bus_overlap_flags_total{result="flagged"} 0',
      'alcantara_program_bus_overlap_flags_total{result="missing"} 0',
      'alcantara_program_bus_overlaps_total{kind="song_song"} 1',
      'alcantara_program_bus_overlaps_total{kind="spot_song"} 0',
    ]);
  });
});
