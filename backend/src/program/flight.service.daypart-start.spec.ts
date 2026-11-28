/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call */
import { RadioMetricsService } from '../radio/radio-metrics.service';
import { noRecorder } from '../operator-change/operator-change-recorder.testing';
import { DAYPART_SOFT_WAIT_MS, FlightService } from './flight.service';

// gaulatti/alcantara#124: how a block made from a daypart clock takes the air.
const AT = Date.parse('2026-12-07T06:00:00Z');
const items = [
  { id: 'a', kind: 'playSong', songId: 1, clockOffsetSeconds: 0 },
  { id: 'b', kind: 'playSong', songId: 2 },
];

function setup(
  options: {
    start?: string;
    mode?: string | null;
    frozen?: boolean;
    songOnAir?: boolean;
  } = {},
) {
  const block = {
    id: 9,
    clockId: 5,
    daypartStart: options.start ?? 'soft',
    scheduledAt: new Date(AT),
    items,
    programState: { programId: 'fm' },
  };
  const prisma = {
    flightSequence: {
      findMany: jest.fn().mockResolvedValue([block]),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      update: jest.fn().mockResolvedValue({}),
    },
    programState: {
      update: jest.fn().mockResolvedValue({}),
      findUnique: jest.fn().mockResolvedValue({ activeFlightSequenceId: 9 }),
    },
  };
  const program = {
    getRotationOnAir: jest.fn().mockReturnValue({
      mode: options.mode === undefined ? 'autoplay' : options.mode,
      frozen: options.frozen ?? false,
      songOnAir: options.songOnAir ?? true,
    }),
    reviewAnnouncedSong: jest.fn(),
    broadcastUpdate: jest.fn(),
  };
  const metrics = new RadioMetricsService();
  const service = new FlightService(
    prisma as never,
    program as never,
    metrics,
    noRecorder(),
    { teamId: 0 } as never,
  );
  const internals = service as any;
  jest
    .spyOn(internals, 'preflightClockItems')
    .mockResolvedValue({ ready: true, issues: [] });
  const activate = jest
    .spyOn(service, 'activateFlightSequence')
    .mockResolvedValue({ activeSequenceId: 9 });
  const start = jest.spyOn(service, 'start').mockResolvedValue({ ok: true });
  const cue = jest
    .spyOn(internals, 'executeCueAtIndex')
    .mockResolvedValue(undefined);
  const counted = (result: string) =>
    metrics
      .render()
      .includes(`alcantara_radio_daypart_blocks_total{result="${result}"} 1`);
  return {
    service,
    internals,
    prisma,
    program,
    activate,
    start,
    cue,
    counted,
    tick: () => internals.startDuePublishedLogs() as Promise<void>,
  };
}

beforeEach(() => jest.useFakeTimers({ now: AT }));
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('daypart block start', () => {
  it.each([{ mode: 'manual' }, { mode: null }, { frozen: true }])(
    'is skipped when the station is not playing by itself (%j)',
    async (options) => {
      const h = setup(options);
      await h.tick();
      expect(h.activate).not.toHaveBeenCalled();
      expect(h.internals.runtimes.size).toBe(0);
      expect(h.prisma.flightSequence.update).toHaveBeenCalledWith({
        where: { id: 9 },
        data: { daypartOutcome: 'skipped' },
      });
      expect(h.program.broadcastUpdate).toHaveBeenCalledWith('fm', {
        type: 'radio_daypart_skipped',
        sequenceId: 9,
      });
      expect(h.counted('skipped')).toBe(true);
    },
  );

  it.each([{ start: 'hard', mode: 'shuffle' }, { songOnAir: false }])(
    'starts at once (%j)',
    async (options) => {
      const h = setup(options);
      await h.tick();
      expect(h.activate).toHaveBeenCalledWith('fm', 9);
      expect(h.start).toHaveBeenCalledWith('fm');
      expect(h.counted('started')).toBe(true);
    },
  );

  it('waits for the song on air, owning what follows it', async () => {
    const h = setup();
    await h.tick();
    expect(h.activate).not.toHaveBeenCalled();
    expect(h.cue).not.toHaveBeenCalled();
    expect(h.service.isClockedLogRunning('fm')).toBe(true);
    expect(h.program.reviewAnnouncedSong).toHaveBeenCalledWith('fm');
    expect(h.prisma.programState.update).toHaveBeenCalledWith({
      where: { programId: 'fm' },
      data: { activeFlightSequenceId: 9 },
    });
    expect(h.counted('started')).toBe(true);

    // An edit of the waiting block must not replace its wait with a fixed start.
    const runtime = h.internals.runtimes.get('fm');
    const wait = runtime.timer;
    h.internals.armNextHardCue(runtime);
    expect(runtime.timer).toBe(wait);

    await h.service.handleSongEnded('fm');
    expect(h.cue).toHaveBeenCalledWith('fm', 0, expect.any(Number));
  });

  it('cuts a song still on air after the longest wait, and not before', async () => {
    const h = setup();
    await h.tick();
    await jest.advanceTimersByTimeAsync(DAYPART_SOFT_WAIT_MS - 1);
    expect(h.cue).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    expect(h.cue).toHaveBeenCalledTimes(1);
    expect(h.cue).toHaveBeenCalledWith('fm', 0, expect.any(Number));
  });

  it('does not cut once the block has begun or has been replaced', async () => {
    for (const change of ['begun', 'replaced']) {
      const h = setup();
      await h.tick();
      const runtime = h.internals.runtimes.get('fm');
      if (change === 'begun') runtime.activeIndex = 0;
      else h.internals.runtimes.delete('fm');
      await jest.advanceTimersByTimeAsync(DAYPART_SOFT_WAIT_MS);
      expect(h.cue).not.toHaveBeenCalled();
    }
  });

  it('takes over from the block before it without cutting its song', async () => {
    const h = setup();
    const before = jest.fn();
    const previous = {
      sequenceId: 8,
      items,
      activeIndex: 1,
      isRunning: true,
      timer: setTimeout(before, 1000),
    };
    h.internals.runtimes.set('fm', previous);
    await h.tick();
    await jest.advanceTimersByTimeAsync(2000);
    expect(before).not.toHaveBeenCalled();
    expect(previous.isRunning).toBe(false);
    expect(h.prisma.flightSequence.update).toHaveBeenCalledWith({
      where: { id: 8 },
      data: { isRunning: false, activeItemId: 'b' },
    });
    expect(h.internals.runtimes.get('fm').sequenceId).toBe(9);
  });

  it('leaves a block a person published to start as before', async () => {
    const h = setup({ mode: 'manual' });
    h.prisma.flightSequence.findMany.mockResolvedValue([
      { id: 7, clockId: null, items, programState: { programId: 'fm' } },
    ]);
    await h.tick();
    expect(h.activate).toHaveBeenCalledWith('fm', 7);
    expect(h.program.getRotationOnAir).not.toHaveBeenCalled();
  });
});

describe('daypart log service', () => {
  it('proposes what a block would hold without writing it', async () => {
    const h = setup();
    const propose = jest
      .spyOn(h.internals, 'proposeCues')
      .mockResolvedValue(['a song']);
    Object.assign(h.prisma.programState, {
      findUnique: jest.fn().mockResolvedValue({ id: 3 }),
    });
    await expect(
      h.service.previewTaggedLog('fm', new Date(AT), { slots: [] }),
    ).resolves.toEqual(['a song']);
    expect(propose).toHaveBeenCalledWith('fm', 3, new Date(AT), {
      slots: [],
    });
    expect(h.prisma.flightSequence.update).not.toHaveBeenCalled();
  });

  it('says which blocks came from a clock, and only those', () => {
    const h = setup();
    const plain = h.internals.toFlightSequence({ id: 1, items: [] });
    expect(plain).not.toHaveProperty('daypart');
    expect(
      h.internals.toFlightSequence({
        id: 1,
        items: [],
        clockId: 5,
        daypartStart: 'soft',
        daypartOutcome: 'skipped',
      }).daypart,
    ).toEqual({ clockId: 5, start: 'soft', outcome: 'skipped' });
  });
});
