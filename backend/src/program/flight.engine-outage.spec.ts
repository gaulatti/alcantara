/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return */
import { ENGINE_OUTAGE_GRACE_MS, FlightService } from './flight.service';
import { RadioMetricsService } from '../radio/radio-metrics.service';
import { noRecorder } from '../operator-change/operator-change-recorder.testing';

// gaulatti/alcantara#719 / #715: a timed-block cue that fails while the engine is
// down is retried when the engine is back within its grace, and skipped (logged
// as not aired) past it. The block never stops for this.

const DUE_OFFSET_S = 600;

function harness() {
  jest.useFakeTimers();
  const prisma = {
    flightSequence: { update: jest.fn().mockResolvedValue({}) },
    programState: { update: jest.fn().mockResolvedValue({}) },
    asRunRecord: { create: jest.fn().mockResolvedValue({}) },
  };
  const program = {
    broadcastUpdate: jest.fn(),
    stopProgramSongForTimedBlock: jest.fn().mockResolvedValue(undefined),
  };
  const metrics = new RadioMetricsService();
  const recorded = jest.spyOn(metrics, 'recordRadioLogResult');
  const service = new FlightService(
    prisma as any,
    program as any,
    metrics,
    noRecorder(),
  );
  const internals = service as any;
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  jest.spyOn(internals, 'persistRuntimeState').mockResolvedValue(undefined);
  jest.spyOn(internals, 'broadcastFlightUpdate').mockResolvedValue(undefined);
  const executeCue = jest.spyOn(internals, 'executeCue');
  const stop = jest.spyOn(service, 'stop').mockResolvedValue({ ok: true });
  const advance = jest.spyOn(internals, 'advance').mockResolvedValue(undefined);
  const armNextHardCue = jest
    .spyOn(internals, 'armNextHardCue')
    .mockReturnValue(undefined);
  const scheduledAtMs = Date.now() - DUE_OFFSET_S * 1000;
  const runtime: any = {
    sequenceId: 7,
    programId: 'radio-1',
    items: [
      { id: 'opener', kind: 'playSong', songId: 3 },
      {
        id: 'top',
        kind: 'playSong',
        songId: 4,
        clockOffsetSeconds: DUE_OFFSET_S,
      },
      { id: 'after', kind: 'playSong', songId: 5 },
    ],
    loop: false,
    activeIndex: 0,
    isRunning: true,
    generation: 1,
    timer: null,
    waitingForSongEnd: false,
    startedAt: scheduledAtMs,
    scheduledAtMs,
  };
  internals.runtimes.set('radio-1', runtime);
  const dueAt = scheduledAtMs + DUE_OFFSET_S * 1000;
  const run = (index = 1) =>
    internals.executeCueAtIndex('radio-1', index, runtime.generation);
  return {
    prisma,
    program,
    metrics,
    recorded,
    service,
    executeCue,
    stop,
    advance,
    armNextHardCue,
    runtime,
    dueAt,
    run,
  };
}

/** Lets the void retry/skip chains settle under fake timers. */
async function settle() {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('FlightService engine outage grace (#719)', () => {
  it('retries a fixed-time cue once the engine is back within the grace and keeps the block', async () => {
    const h = harness();
    h.service.handleEngineAvailability('radio-1', false);
    h.executeCue.mockRejectedValueOnce(new Error('Palazzo unreachable'));
    await h.run();
    expect(h.stop).not.toHaveBeenCalled();
    expect(h.recorded).not.toHaveBeenCalledWith('cue-failed');
    expect(h.runtime.engineRetry).toEqual({ index: 1, dueAt: h.dueAt });

    jest.advanceTimersByTime(20_000);
    h.executeCue.mockResolvedValueOnce(undefined);
    h.service.handleEngineAvailability('radio-1', true);
    await settle();

    expect(h.executeCue).toHaveBeenCalledTimes(2);
    expect(h.recorded).toHaveBeenCalledWith('cue-retried');
    expect(h.runtime.engineRetry).toBeUndefined();
    expect(h.runtime.waitingForSongEnd).toBe(true);
    expect(h.armNextHardCue).toHaveBeenCalledWith(h.runtime);
    expect(h.stop).not.toHaveBeenCalled();
    expect(h.prisma.asRunRecord.create).not.toHaveBeenCalled();
    expect(h.metrics.render()).toMatch(/result="cue-retried"\} 1/);

    // The hold timer was cleared: nothing is skipped later.
    jest.advanceTimersByTime(ENGINE_OUTAGE_GRACE_MS);
    await settle();
    expect(h.recorded).not.toHaveBeenCalledWith('cue-skipped');
  });

  it('skips the cue past the grace with a not-aired row and runs the next cue', async () => {
    const h = harness();
    h.service.handleEngineAvailability('radio-1', false);
    h.executeCue.mockRejectedValue(new Error('Palazzo unreachable'));
    await h.run();

    jest.advanceTimersByTime(ENGINE_OUTAGE_GRACE_MS - 1);
    await settle();
    expect(h.recorded).not.toHaveBeenCalledWith('cue-skipped');

    jest.advanceTimersByTime(1);
    await settle();
    expect(h.recorded).toHaveBeenCalledWith('cue-skipped');
    expect(h.prisma.asRunRecord.create).toHaveBeenCalledWith({
      data: {
        programId: 'radio-1',
        songId: 4,
        state: 'not-aired',
        endReason: 'engine_unavailable',
        at: expect.any(Date),
        // #726: the row names the rundown and cue, so the rundown shows it as skipped.
        flightSequenceId: 7,
        flightCueId: 'top',
      },
    });
    expect(h.program.broadcastUpdate).toHaveBeenCalledWith('radio-1', {
      type: 'radio_log_cue_skipped',
      sequenceId: 7,
      cueId: 'top',
    });
    expect(h.advance).toHaveBeenCalledWith('radio-1', 1);
    expect(h.stop).not.toHaveBeenCalled();
    expect(h.runtime.engineRetry).toBeUndefined();
    expect(h.metrics.render()).toMatch(/result="cue-skipped"\} 1/);

    // The engine returning after the skip retries nothing.
    h.service.handleEngineAvailability('radio-1', true);
    await settle();
    expect(h.executeCue).toHaveBeenCalledTimes(1);
  });

  it('counts the grace from the due time, not from when the cue failed', async () => {
    const h = harness();
    jest.advanceTimersByTime(45_000);
    h.service.handleEngineAvailability('radio-1', false);
    h.executeCue.mockRejectedValue(new Error('Palazzo unreachable'));
    await h.run();
    jest.advanceTimersByTime(ENGINE_OUTAGE_GRACE_MS - 45_000);
    await settle();
    expect(h.recorded).toHaveBeenCalledWith('cue-skipped');
  });

  it('holds a retry that fails again and skips it at the same deadline', async () => {
    const h = harness();
    h.service.handleEngineAvailability('radio-1', false);
    h.executeCue.mockRejectedValue(new Error('Palazzo unreachable'));
    await h.run();
    jest.advanceTimersByTime(10_000);
    h.service.handleEngineAvailability('radio-1', true);
    await settle();
    expect(h.executeCue).toHaveBeenCalledTimes(2);
    expect(h.stop).not.toHaveBeenCalled();
    expect(h.recorded).not.toHaveBeenCalledWith('cue-failed');
    expect(h.recorded).not.toHaveBeenCalledWith('cue-retried');
    expect(h.runtime.engineRetry).toEqual({ index: 1, dueAt: h.dueAt });

    jest.advanceTimersByTime(ENGINE_OUTAGE_GRACE_MS - 10_000);
    await settle();
    expect(h.recorded).toHaveBeenCalledWith('cue-skipped');
    expect(h.advance).toHaveBeenCalledWith('radio-1', 1);
  });

  it('gives a cue without a clock time its grace from when it first failed', async () => {
    const h = harness();
    h.service.handleEngineAvailability('radio-1', false);
    h.executeCue.mockRejectedValue(new Error('Palazzo unreachable'));
    const failedAt = Date.now();
    await h.run(2);
    expect(h.runtime.engineRetry).toEqual({ index: 2, dueAt: failedAt });
    jest.advanceTimersByTime(10_000);
    h.service.handleEngineAvailability('radio-1', true);
    await settle();
    // The failed retry keeps the first failure as its due time.
    expect(h.runtime.engineRetry).toEqual({ index: 2, dueAt: failedAt });
    jest.advanceTimersByTime(ENGINE_OUTAGE_GRACE_MS - 10_000);
    await settle();
    expect(h.prisma.asRunRecord.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        songId: 5,
        state: 'not-aired',
        flightSequenceId: 7,
        flightCueId: 'after',
      }),
    });
  });

  it('writes no as-run row for a skipped cue that is not a song', async () => {
    const h = harness();
    h.runtime.items[1] = {
      id: 'top',
      kind: 'instant',
      instantId: 9,
      clockOffsetSeconds: DUE_OFFSET_S,
    };
    h.service.handleEngineAvailability('radio-1', false);
    h.executeCue.mockRejectedValue(new Error('Palazzo unreachable'));
    await h.run();
    jest.advanceTimersByTime(ENGINE_OUTAGE_GRACE_MS);
    await settle();
    expect(h.recorded).toHaveBeenCalledWith('cue-skipped');
    expect(h.prisma.asRunRecord.create).not.toHaveBeenCalled();
    expect(h.advance).toHaveBeenCalledWith('radio-1', 1);
  });

  it('still runs the next cue when the not-aired row cannot be written', async () => {
    const h = harness();
    const logged = jest
      .spyOn((h.service as any).logger, 'error')
      .mockImplementation(() => undefined);
    h.prisma.asRunRecord.create.mockRejectedValue(new Error('db down'));
    h.service.handleEngineAvailability('radio-1', false);
    h.executeCue.mockRejectedValue(new Error('Palazzo unreachable'));
    await h.run();
    jest.advanceTimersByTime(ENGINE_OUTAGE_GRACE_MS);
    await settle();
    expect(logged).toHaveBeenCalledWith(
      'Could not log a skipped cue as not aired for radio-1',
      expect.any(Error),
    );
    expect(h.advance).toHaveBeenCalledWith('radio-1', 1);
  });

  it.each([
    [
      'the block was stopped',
      (r: any) => {
        r.isRunning = false;
      },
    ],
    [
      'the block moved to another generation',
      (r: any) => {
        r.generation = 2;
      },
    ],
    [
      'the hold was cleared',
      (r: any) => {
        r.engineRetry = undefined;
      },
    ],
  ])('skips nothing when %s before the deadline', async (_name, change) => {
    const h = harness();
    h.service.handleEngineAvailability('radio-1', false);
    h.executeCue.mockRejectedValue(new Error('Palazzo unreachable'));
    await h.run();
    change(h.runtime);
    jest.advanceTimersByTime(ENGINE_OUTAGE_GRACE_MS);
    await settle();
    expect(h.recorded).not.toHaveBeenCalledWith('cue-skipped');
    expect(h.advance).not.toHaveBeenCalled();
  });

  it('skips nothing for a runtime replaced before the deadline', async () => {
    const h = harness();
    h.service.handleEngineAvailability('radio-1', false);
    h.executeCue.mockRejectedValue(new Error('Palazzo unreachable'));
    await h.run();
    (h.service as any).runtimes.set('radio-1', { ...h.runtime });
    jest.advanceTimersByTime(ENGINE_OUTAGE_GRACE_MS);
    await settle();
    expect(h.recorded).not.toHaveBeenCalledWith('cue-skipped');
  });

  it('still stops the block for a cue failure while the engine is up', async () => {
    const h = harness();
    h.executeCue.mockRejectedValue(new Error('no audio'));
    await h.run();
    expect(h.recorded).toHaveBeenCalledWith('cue-failed');
    expect(h.stop).toHaveBeenCalledWith('radio-1', { flightDriven: true });
    expect(h.runtime.engineRetry).toBeUndefined();
  });

  it('ignores availability with no running block or nothing held', async () => {
    const h = harness();
    h.service.handleEngineAvailability('other', true);
    h.service.handleEngineAvailability('radio-1', true);
    h.runtime.isRunning = false;
    h.runtime.engineRetry = { index: 1, dueAt: h.dueAt };
    h.service.handleEngineAvailability('radio-1', true);
    await settle();
    expect(h.executeCue).not.toHaveBeenCalled();
  });

  it('clears a stale hold left on another row when a cue succeeds', async () => {
    const h = harness();
    h.executeCue.mockResolvedValue(undefined);
    h.runtime.engineRetry = { index: 0, dueAt: h.dueAt };
    await h.run();
    expect(h.runtime.engineRetry).toBeUndefined();
    expect(h.recorded).not.toHaveBeenCalledWith('cue-retried');
  });
});
