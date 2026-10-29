/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/require-await */
import { BadRequestException } from '@nestjs/common';
import { FlightService } from './flight.service';
import { ProgramService } from './program.service';
import { RadioMetricsService } from '../radio/radio-metrics.service';

const MAX_TIMER = 2_147_483_647;

function harness(stateExtra: Record<string, unknown> = {}) {
  const prisma = {
    programState: {
      findUnique: jest.fn().mockResolvedValue({
        id: 1,
        programId: 'radio-1',
        type: 'radio',
        activeFlightSequenceId: 7,
        ...stateExtra,
      }),
      update: jest.fn().mockResolvedValue({}),
    },
    flightSequence: {
      update: jest.fn().mockResolvedValue({}),
    },
    song: { findUnique: jest.fn() },
    scene: { findUnique: jest.fn(), update: jest.fn() },
  };
  const program = {
    broadcastUpdate: jest.fn(),
    takeProgramSongOffAir: jest.fn().mockResolvedValue(undefined),
    stopProgramSongForTimedBlock: jest.fn().mockResolvedValue(undefined),
    prepareContinuousRotationResume: jest.fn().mockResolvedValue(undefined),
    resumeContinuousRotation: jest.fn(),
    activateScene: jest.fn().mockResolvedValue(undefined),
    playInstant: jest.fn().mockResolvedValue(undefined),
    updateProgramAudioBus: jest.fn().mockResolvedValue(undefined),
    takeCatalogSongOnAir: jest.fn(),
    getProgramIdsByAssignedScene: jest.fn().mockResolvedValue([]),
    getProgramAudioBus: jest.fn(),
  };
  const metrics = new RadioMetricsService();
  const recorded = jest.spyOn(metrics, 'recordRadioLogResult');
  const service = new FlightService(prisma as any, program as any, metrics);
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  const errors = jest
    .spyOn(console, 'error')
    .mockImplementation(() => undefined);
  return {
    prisma,
    program,
    recorded,
    errors,
    service,
    internals: service as any,
  };
}

function runtimeState(extra: Record<string, unknown> = {}) {
  return {
    sequenceId: 7,
    programId: 'radio-1',
    items: [
      { id: 'a', kind: 'playSong', songId: 1, clockOffsetSeconds: 0 },
      { id: 'b', kind: 'playSong', songId: 1 },
      { id: 'c', kind: 'playSong', songId: 1, clockOffsetSeconds: 1800 },
    ],
    loop: false,
    activeIndex: 0,
    isRunning: true,
    generation: 1,
    timer: null,
    waitingForSongEnd: false,
    startedAt: Date.now(),
    scheduledAtMs: null,
    ...extra,
  } as any;
}

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('FlightService cue sequencing', () => {
  function setup(runtime: any, stateExtra: Record<string, unknown> = {}) {
    jest.useFakeTimers();
    const h = harness(stateExtra);
    h.internals.runtimes.set('radio-1', runtime);
    const executeCue = jest
      .spyOn(h.internals, 'executeCue')
      .mockResolvedValue(undefined);
    const advance = jest
      .spyOn(h.internals, 'advance')
      .mockResolvedValue(undefined);
    return { ...h, executeCue, advance };
  }
  const run = (h: any, index: number, generation = 1) =>
    h.internals.executeCueAtIndexUnlocked('radio-1', index, generation);

  it.each([
    ['no runtime', undefined, 1],
    ['a stale generation', runtimeState(), 9],
    ['a stopped runtime', runtimeState({ isRunning: false }), 1],
  ])('does nothing for %s', async (_name, runtime, generation) => {
    const h = setup(runtime);
    if (!runtime) h.internals.runtimes.clear();
    await run(h, 0, generation);
    expect(h.executeCue).not.toHaveBeenCalled();
    expect(h.prisma.flightSequence.update).not.toHaveBeenCalled();
  });

  it('finishes a non-looping sequence for an out-of-range index', async () => {
    const runtime = runtimeState({
      items: [{ id: 'w', kind: 'wait' }],
    });
    const h = setup(runtime);
    const stop = jest.spyOn(h.service, 'stop').mockResolvedValue({ ok: true });
    await run(h, 5);
    await run(h, -1);
    expect(stop).toHaveBeenCalledTimes(2);
    expect(h.executeCue).not.toHaveBeenCalled();
  });

  it('wraps a looping sequence back to the first cue', async () => {
    const runtime = runtimeState({
      loop: true,
      items: [{ id: 'w', kind: 'scene' }],
    });
    const h = setup(runtime);
    await run(h, 1);
    expect(runtime.activeIndex).toBe(0);
    expect(h.executeCue).toHaveBeenCalledWith('radio-1', runtime.items[0]);
  });

  it('finishes a looping sequence with no cues', async () => {
    const runtime = runtimeState({ loop: true, items: [] });
    const h = setup(runtime);
    const stop = jest.spyOn(h.service, 'stop').mockResolvedValue({ ok: true });
    await run(h, 0);
    expect(stop).toHaveBeenCalledWith('radio-1');
  });

  it('waits for a fixed clock offset before executing a cue', async () => {
    const runtime = runtimeState({ scheduledAtMs: Date.now() });
    const h = setup(runtime);
    const again = jest
      .spyOn(h.internals, 'executeCueAtIndex')
      .mockResolvedValue(undefined);
    runtime.items[0].clockOffsetSeconds = 30;
    await run(h, 0);
    expect(h.executeCue).not.toHaveBeenCalled();
    expect(runtime.timer).not.toBeNull();
    jest.advanceTimersByTime(30_000);
    expect(again).toHaveBeenCalledWith('radio-1', 0, 1);
  });

  it('caps very distant fixed starts at the platform timer limit', async () => {
    const runtime = runtimeState({ scheduledAtMs: Date.now() });
    const h = setup(runtime);
    const again = jest
      .spyOn(h.internals, 'executeCueAtIndex')
      .mockResolvedValue(undefined);
    runtime.items[0].clockOffsetSeconds = 10_000_000;
    await run(h, 0);
    jest.advanceTimersByTime(MAX_TIMER - 1);
    expect(again).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(again).toHaveBeenCalledTimes(1);
  });

  it('executes immediately once a fixed start is due, or for unclocked runtimes', async () => {
    const due = runtimeState({ scheduledAtMs: Date.now() - 5000 });
    const dueHarness = setup(due);
    due.items[0].clockOffsetSeconds = 1;
    await run(dueHarness, 0);
    expect(dueHarness.executeCue).toHaveBeenCalledTimes(1);

    const plain = runtimeState({ scheduledAtMs: null });
    const plainHarness = setup(plain);
    plain.items[0].clockOffsetSeconds = 1000;
    await run(plainHarness, 0);
    expect(plainHarness.executeCue).toHaveBeenCalledTimes(1);

    const unclocked = runtimeState({ scheduledAtMs: Date.now() });
    const unclockedHarness = setup(unclocked);
    await run(unclockedHarness, 1);
    expect(unclockedHarness.executeCue).toHaveBeenCalledTimes(1);
  });

  it('persists and broadcasts the cursor, then advances after a plain cue', async () => {
    const runtime = runtimeState({
      items: [{ id: 'sc', kind: 'scene' }],
      waitingForSongEnd: true,
    });
    const h = setup(runtime);
    await run(h, 0);
    expect(runtime.waitingForSongEnd).toBe(false);
    expect(h.prisma.flightSequence.update).toHaveBeenCalledWith({
      where: { id: 7 },
      data: { isRunning: true, activeItemId: 'sc' },
    });
    expect(h.program.broadcastUpdate).toHaveBeenCalledWith(
      'radio-1',
      expect.objectContaining({
        type: 'flight_update',
        activeSequenceId: 7,
        runtime: expect.objectContaining({ activeItemId: 'sc' }),
      }),
    );
    expect(h.executeCue).toHaveBeenCalledWith('radio-1', runtime.items[0]);
    expect(h.advance).toHaveBeenCalledWith('radio-1', 1);
  });

  describe('timed blocks', () => {
    it('stops the filler before a song or timed clip, but not a plain clip', async () => {
      const runtime = runtimeState({
        scheduledAtMs: Date.now() - 1000,
        items: [
          { id: 's', kind: 'playSong', songId: 1 },
          { id: 'c', kind: 'instant', instantId: 2, durationMs: 1000 },
          { id: 'p', kind: 'instant', instantId: 3 },
          { id: 'x', kind: 'stopSong' },
        ],
      });
      const h = setup(runtime);
      const armHard = jest
        .spyOn(h.internals, 'armNextHardCue')
        .mockReturnValue(undefined);
      const armClip = jest
        .spyOn(h.internals, 'armTimedClip')
        .mockReturnValue(undefined);

      await run(h, 0);
      expect(h.program.stopProgramSongForTimedBlock).toHaveBeenCalledTimes(1);
      expect(runtime.waitingForSongEnd).toBe(true);
      expect(armHard).toHaveBeenCalledWith(runtime);
      expect(h.advance).not.toHaveBeenCalled();

      await run(h, 1);
      expect(h.program.stopProgramSongForTimedBlock).toHaveBeenCalledTimes(2);
      expect(runtime.cueStartedAt).toBe(Date.now());
      expect(armClip).toHaveBeenCalledWith(runtime);
      expect(h.advance).not.toHaveBeenCalled();

      await run(h, 2);
      expect(h.program.stopProgramSongForTimedBlock).toHaveBeenCalledTimes(2);
      expect(h.advance).toHaveBeenCalledTimes(1);

      await run(h, 3);
      expect(h.advance).toHaveBeenCalledTimes(2);
    });

    it('stops the log and reports a failed cue instead of continuing', async () => {
      const runtime = runtimeState({
        scheduledAtMs: Date.now() - 1000,
        items: [{ id: 's', kind: 'playSong', songId: 1 }],
      });
      const h = setup(runtime);
      h.executeCue.mockRejectedValue(new Error('no audio'));
      const stop = jest
        .spyOn(h.service, 'stop')
        .mockResolvedValue({ ok: true });
      await run(h, 0);
      expect(h.errors).toHaveBeenCalled();
      expect(h.recorded).toHaveBeenCalledWith('cue-failed');
      expect(stop).toHaveBeenCalledWith('radio-1');
      expect(h.program.broadcastUpdate).toHaveBeenCalledWith('radio-1', {
        type: 'radio_log_cue_failed',
        sequenceId: 7,
        cueId: 's',
      });
      expect(h.advance).not.toHaveBeenCalled();
    });
  });

  it('keeps going after a failed cue in an unscheduled sequence', async () => {
    const runtime = runtimeState({
      items: [{ id: 'sc', kind: 'scene', sceneId: 1 }],
    });
    const h = setup(runtime);
    h.executeCue.mockRejectedValue(new Error('scene gone'));
    await run(h, 0);
    expect(h.errors).toHaveBeenCalledWith(
      'Flight cue execution failed (scene)',
      expect.any(Error),
    );
    expect(h.recorded).not.toHaveBeenCalled();
    expect(h.advance).toHaveBeenCalledWith('radio-1', 1);
  });

  it.each([
    [
      'the generation changed',
      (r: any) => {
        r.generation = 2;
      },
    ],
    [
      'the runtime stopped',
      (r: any) => {
        r.isRunning = false;
      },
    ],
  ])('abandons the cue when %s while it executes', async (_name, mutate) => {
    const runtime = runtimeState({
      items: [{ id: 'w', kind: 'wait', durationMs: 5 }],
    });
    const h = setup(runtime);
    h.executeCue.mockImplementation(async () => mutate(runtime));
    await run(h, 0);
    expect(h.advance).not.toHaveBeenCalled();
    expect(runtime.timer).toBeNull();
  });

  it('schedules the next cue after a timed wait, clamping bad durations to zero', async () => {
    const runtime = runtimeState({
      items: [
        { id: 'w1', kind: 'wait', durationMs: 2500 },
        { id: 'w2', kind: 'wait' },
        { id: 'w3', kind: 'wait', durationMs: -5 },
      ],
    });
    const h = setup(runtime);
    await run(h, 0);
    expect(h.advance).not.toHaveBeenCalled();
    jest.advanceTimersByTime(2499);
    expect(h.advance).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(h.advance).toHaveBeenCalledWith('radio-1', 1);
    await run(h, 1);
    jest.advanceTimersByTime(0);
    expect(h.advance).toHaveBeenCalledTimes(2);
    await run(h, 2);
    jest.advanceTimersByTime(0);
    expect(h.advance).toHaveBeenCalledTimes(3);
  });

  describe('waiting for a song end', () => {
    const runtimeWaiting = () =>
      runtimeState({ items: [{ id: 'ws', kind: 'waitForSongEnd' }] });

    it('times out after five minutes and moves on under a new generation', async () => {
      const runtime = runtimeWaiting();
      const h = setup(runtime);
      await run(h, 0);
      expect(runtime.waitingForSongEnd).toBe(true);
      jest.advanceTimersByTime(5 * 60 * 1000 - 1);
      expect(h.advance).not.toHaveBeenCalled();
      jest.advanceTimersByTime(1);
      expect(runtime.waitingForSongEnd).toBe(false);
      expect(runtime.generation).toBe(2);
      expect(h.advance).toHaveBeenCalledWith('radio-1', 2);
    });

    it('does nothing at the timeout when the song already ended', async () => {
      const runtime = runtimeWaiting();
      const h = setup(runtime);
      await run(h, 0);
      runtime.waitingForSongEnd = false;
      jest.advanceTimersByTime(5 * 60 * 1000);
      expect(h.advance).not.toHaveBeenCalled();
      expect(runtime.generation).toBe(1);
    });

    it('does nothing at the timeout when the runtime was removed', async () => {
      const runtime = runtimeWaiting();
      const h = setup(runtime);
      await run(h, 0);
      h.internals.runtimes.delete('radio-1');
      jest.advanceTimersByTime(5 * 60 * 1000);
      expect(h.advance).not.toHaveBeenCalled();
    });
  });
});

describe('FlightService timed clip timer', () => {
  function setup(runtimeExtra: Record<string, unknown> = {}) {
    jest.useFakeTimers();
    const h = harness();
    const base = Date.now();
    const runtime = runtimeState({
      scheduledAtMs: base,
      generation: 4,
      cueStartedAt: base,
      items: [
        {
          id: 'clip',
          kind: 'instant',
          instantId: 1,
          durationMs: 10_000,
          clockOffsetSeconds: 0,
        },
        { id: 'follow', kind: 'playSong', songId: 1 },
        { id: 'hard', kind: 'playSong', songId: 1, clockOffsetSeconds: 60 },
      ],
      ...runtimeExtra,
    });
    h.internals.runtimes.set('radio-1', runtime);
    const execute = jest
      .spyOn(h.internals, 'executeCueAtIndex')
      .mockResolvedValue(undefined);
    return { ...h, runtime, execute, base };
  }

  it.each([
    ['no declared duration', { items: [{ id: 'c', kind: 'instant' }] }],
    ['no active cue', { activeIndex: 9 }],
    ['an unscheduled runtime', { scheduledAtMs: null }],
    ['no recorded start', { cueStartedAt: undefined }],
  ])('does not arm for %s', (_name, extra) => {
    const { internals, runtime, execute } = setup(extra);
    jest.advanceTimersByTime(0);
    internals.armTimedClip(runtime);
    expect(runtime.timer).toBeNull();
    jest.advanceTimersByTime(1_000_000);
    expect(execute).not.toHaveBeenCalled();
  });

  it('replaces a previous timer and advances to the next cue when the clip ends', () => {
    const { internals, runtime, execute } = setup();
    const stale = setTimeout(() => undefined, 1);
    runtime.timer = stale;
    internals.armTimedClip(runtime);
    expect(runtime.timer).not.toBe(stale);
    jest.advanceTimersByTime(9999);
    expect(execute).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(execute).toHaveBeenCalledWith('radio-1', 1, 4);
  });

  it('jumps to the fixed cue when it falls due before the clip ends', () => {
    const { internals, runtime, execute } = setup();
    runtime.items[2].clockOffsetSeconds = 5;
    internals.armTimedClip(runtime);
    jest.advanceTimersByTime(5000);
    expect(execute).toHaveBeenCalledWith('radio-1', 2, 4);
  });

  it('uses the clip end when it precedes the next fixed cue', () => {
    const { internals, runtime, execute } = setup();
    runtime.items[2].clockOffsetSeconds = 10;
    internals.armTimedClip(runtime);
    jest.advanceTimersByTime(10_000);
    expect(execute).toHaveBeenCalledWith('radio-1', 2, 4);
    execute.mockClear();
    runtime.items[2].clockOffsetSeconds = 11;
    internals.armTimedClip(runtime);
    jest.advanceTimersByTime(10_000);
    expect(execute).toHaveBeenCalledWith('radio-1', 1, 4);
  });

  it('advances to the following cue when no fixed cue remains', () => {
    const { internals, runtime, execute } = setup();
    runtime.items = runtime.items.slice(0, 2);
    internals.armTimedClip(runtime);
    jest.advanceTimersByTime(10_000);
    expect(execute).toHaveBeenCalledWith('radio-1', 1, 4);
  });

  it.each([
    [
      'the runtime was replaced',
      (_r: any, i: any) => i.runtimes.set('radio-1', runtimeState()),
    ],
    [
      'the generation changed',
      (r: any) => {
        r.generation = 5;
      },
    ],
    [
      'the runtime stopped',
      (r: any) => {
        r.isRunning = false;
      },
    ],
    [
      'the fixed cue was removed',
      (r: any) => {
        r.items[2].clockOffsetSeconds = 5;
        r.items = r.items.slice(0, 2);
      },
    ],
  ])('does nothing at the deadline if %s', (_name, mutate) => {
    const { internals, runtime, execute } = setup();
    if (_name === 'the fixed cue was removed')
      runtime.items[2].clockOffsetSeconds = 5;
    internals.armTimedClip(runtime);
    mutate(runtime, internals);
    jest.advanceTimersByTime(20_000);
    expect(execute).not.toHaveBeenCalled();
  });

  it('re-arms when the capped timer fires before the real deadline', () => {
    const { internals, runtime, execute } = setup({
      cueStartedAt: Date.now(),
    });
    runtime.items[0].durationMs = MAX_TIMER * 2;
    runtime.items = runtime.items.slice(0, 2);
    internals.armTimedClip(runtime);
    jest.advanceTimersByTime(MAX_TIMER);
    expect(execute).not.toHaveBeenCalled();
    expect(runtime.timer).not.toBeNull();
    jest.advanceTimersByTime(MAX_TIMER);
    expect(execute).toHaveBeenCalledWith('radio-1', 1, 4);
  });
});

describe('FlightService hard cue timer', () => {
  function setup(runtimeExtra: Record<string, unknown> = {}) {
    jest.useFakeTimers();
    const h = harness();
    const base = Date.now();
    const runtime = runtimeState({
      scheduledAtMs: base,
      generation: 4,
      waitingForSongEnd: true,
      items: [
        { id: 'song', kind: 'playSong', songId: 1, clockOffsetSeconds: 0 },
        { id: 'free', kind: 'playSong', songId: 1 },
        { id: 'hard', kind: 'playSong', songId: 1, clockOffsetSeconds: 60 },
      ],
      ...runtimeExtra,
    });
    h.internals.runtimes.set('radio-1', runtime);
    const execute = jest
      .spyOn(h.internals, 'executeCueAtIndex')
      .mockResolvedValue(undefined);
    return { ...h, runtime, execute };
  }

  it('does not arm without a later fixed cue or an unscheduled runtime', () => {
    const noHard = setup();
    noHard.runtime.items = noHard.runtime.items.slice(0, 2);
    noHard.internals.armNextHardCue(noHard.runtime);
    expect(noHard.runtime.timer).toBeNull();

    const unscheduled = setup({ scheduledAtMs: null });
    unscheduled.internals.armNextHardCue(unscheduled.runtime);
    expect(unscheduled.runtime.timer).toBeNull();
  });

  it('forces the fixed cue when it falls due, advancing the generation', () => {
    const { internals, runtime, execute } = setup();
    const stale = setTimeout(() => undefined, 1);
    runtime.timer = stale;
    internals.armNextHardCue(runtime);
    jest.advanceTimersByTime(59_999);
    expect(execute).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(runtime.waitingForSongEnd).toBe(false);
    expect(runtime.generation).toBe(5);
    expect(execute).toHaveBeenCalledWith('radio-1', 2, 5);
  });

  it('fires at once for an overdue fixed cue', () => {
    const { internals, runtime, execute } = setup({
      scheduledAtMs: Date.now() - 120_000,
    });
    internals.armNextHardCue(runtime);
    jest.advanceTimersByTime(0);
    expect(execute).toHaveBeenCalledWith('radio-1', 2, 5);
  });

  it.each([
    ['the runtime is gone', (_r: any, i: any) => i.runtimes.delete('radio-1')],
    [
      'the generation changed',
      (r: any) => {
        r.generation = 9;
      },
    ],
    [
      'the song already ended',
      (r: any) => {
        r.waitingForSongEnd = false;
      },
    ],
    [
      'the fixed cue was removed',
      (r: any) => {
        r.items = r.items.slice(0, 2);
      },
    ],
  ])('does nothing at the deadline if %s', (_name, mutate) => {
    const { internals, runtime, execute } = setup();
    internals.armNextHardCue(runtime);
    mutate(runtime, internals);
    jest.advanceTimersByTime(120_000);
    expect(execute).not.toHaveBeenCalled();
  });

  it('re-arms when the capped timer fires before the real deadline', () => {
    const { internals, runtime, execute } = setup();
    runtime.items[2].clockOffsetSeconds = Math.floor(MAX_TIMER / 1000) * 2;
    internals.armNextHardCue(runtime);
    jest.advanceTimersByTime(MAX_TIMER);
    expect(execute).not.toHaveBeenCalled();
    expect(runtime.timer).not.toBeNull();
    jest.advanceTimersByTime(MAX_TIMER);
    expect(execute).toHaveBeenCalledWith('radio-1', 2, 5);
  });
});

describe('FlightService automatic advance and block completion', () => {
  function setup(runtime?: any) {
    const h = harness();
    if (runtime) h.internals.runtimes.set('radio-1', runtime);
    const execute = jest
      .spyOn(h.internals, 'executeCueAtIndex')
      .mockResolvedValue(undefined);
    const finish = jest
      .spyOn(h.internals, 'finishBlock')
      .mockResolvedValue(undefined);
    return { ...h, execute, finish };
  }

  it.each([
    ['no runtime', undefined, 1],
    ['a stale generation', runtimeState(), 2],
    ['a stopped runtime', runtimeState({ isRunning: false }), 1],
  ])('ignores an advance with %s', async (_name, runtime, generation) => {
    const { internals, execute, finish } = setup(runtime);
    await internals.advance('radio-1', generation);
    expect(execute).not.toHaveBeenCalled();
    expect(finish).not.toHaveBeenCalled();
  });

  it('moves to the next cue, wraps a loop, or finishes the block', async () => {
    const mid = setup(runtimeState({ activeIndex: 0 }));
    await mid.internals.advance('radio-1', 1);
    expect(mid.execute).toHaveBeenCalledWith('radio-1', 1, 1);

    const looping = setup(runtimeState({ activeIndex: 2, loop: true }));
    await looping.internals.advance('radio-1', 1);
    expect(looping.execute).toHaveBeenCalledWith('radio-1', 0, 1);

    const ending = runtimeState({ activeIndex: 2 });
    const last = setup(ending);
    await last.internals.advance('radio-1', 1);
    expect(last.finish).toHaveBeenCalledWith(ending);
  });

  it('stops an unscheduled sequence when it finishes', async () => {
    const h = harness();
    const stop = jest.spyOn(h.service, 'stop').mockResolvedValue({ ok: true });
    await h.internals.finishBlock(runtimeState());
    expect(stop).toHaveBeenCalledWith('radio-1');
    expect(h.program.prepareContinuousRotationResume).not.toHaveBeenCalled();
  });

  it('resumes the continuous rotation after a clocked block completes', async () => {
    const h = harness();
    const stopRuntime = jest
      .spyOn(h.internals, 'stopRuntime')
      .mockResolvedValue({ ok: true });
    await h.internals.finishBlock(runtimeState({ scheduledAtMs: 1 }));
    expect(h.program.prepareContinuousRotationResume).toHaveBeenCalledWith(
      'radio-1',
    );
    expect(stopRuntime).toHaveBeenCalledWith('radio-1', true);
    expect(h.program.resumeContinuousRotation).toHaveBeenCalledWith('radio-1');
    expect(h.recorded).toHaveBeenCalledWith('completed');
  });

  it('reports a failed resume and stops the log', async () => {
    const h = harness();
    const logged = jest
      .spyOn(h.internals.logger, 'error')
      .mockImplementation(() => undefined);
    jest.spyOn(h.internals, 'stopRuntime').mockRejectedValue(new Error('cut'));
    const stop = jest.spyOn(h.service, 'stop').mockResolvedValue({ ok: true });
    await h.internals.finishBlock(runtimeState({ scheduledAtMs: 1 }));
    expect(h.recorded).toHaveBeenCalledWith('resume-failed');
    expect(stop).toHaveBeenCalledWith('radio-1');
    expect(h.program.broadcastUpdate).toHaveBeenCalledWith('radio-1', {
      type: 'radio_rotation_resume_failed',
      sequenceId: 7,
    });
    expect(logged).toHaveBeenCalledWith(
      'Continuous rotation could not resume after a timed block',
    );
  });
});

describe('FlightService cue execution', () => {
  const cue = (extra: Record<string, unknown>) =>
    ({ id: 'c', ...extra }) as any;

  it('activates scenes with their transition, or none', async () => {
    const { internals, program } = harness();
    await internals.executeCue('radio-1', cue({ kind: 'scene', sceneId: 4 }));
    await internals.executeCue(
      'radio-1',
      cue({ kind: 'scene', sceneId: 5, transitionId: 'fade' }),
    );
    await internals.executeCue('radio-1', cue({ kind: 'scene' }));
    expect(program.activateScene).toHaveBeenCalledTimes(2);
    expect(program.activateScene).toHaveBeenNthCalledWith(
      1,
      4,
      'radio-1',
      null,
    );
    expect(program.activateScene).toHaveBeenNthCalledWith(
      2,
      5,
      'radio-1',
      'fade',
    );
  });

  it('delegates song cues to the catalog player', async () => {
    const { internals } = harness();
    const play = jest
      .spyOn(internals, 'executePlaySongCue')
      .mockResolvedValue(undefined);
    const song = cue({ kind: 'playSong', songId: 1 });
    await internals.executeCue('radio-1', song);
    expect(play).toHaveBeenCalledWith('radio-1', song);
  });

  it('cuts the song according to ownership of the clocked log', async () => {
    const { internals, program } = harness();
    await internals.executeCue('radio-1', cue({ kind: 'stopSong' }));
    expect(program.takeProgramSongOffAir).toHaveBeenCalledWith('radio-1');
    expect(program.stopProgramSongForTimedBlock).not.toHaveBeenCalled();
    internals.runtimes.set(
      'radio-1',
      runtimeState({ scheduledAtMs: Date.now() - 1 }),
    );
    await internals.executeCue('radio-1', cue({ kind: 'stopSong' }));
    expect(program.stopProgramSongForTimedBlock).toHaveBeenCalledWith(
      'radio-1',
    );
    expect(program.takeProgramSongOffAir).toHaveBeenCalledTimes(1);
  });

  it('applies scene updates only with a scene and a patch record', async () => {
    const { internals } = harness();
    const update = jest
      .spyOn(internals, 'executeSceneUpdateCue')
      .mockResolvedValue(undefined);
    await internals.executeCue(
      'radio-1',
      cue({ kind: 'sceneUpdate', sceneId: 2, metadataPatch: { a: 1 } }),
    );
    await internals.executeCue(
      'radio-1',
      cue({ kind: 'sceneUpdate', sceneId: 2 }),
    );
    await internals.executeCue(
      'radio-1',
      cue({ kind: 'sceneUpdate', metadataPatch: { a: 1 } }),
    );
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith(2, { a: 1 });
  });

  it('plays clips only with an instant id', async () => {
    const { internals, program } = harness();
    await internals.executeCue(
      'radio-1',
      cue({ kind: 'instant', instantId: 8 }),
    );
    await internals.executeCue('radio-1', cue({ kind: 'instant' }));
    expect(program.playInstant).toHaveBeenCalledTimes(1);
    expect(program.playInstant).toHaveBeenCalledWith(8, 'radio-1');
  });

  it('changes the mixer only with a mixer change record', async () => {
    const { internals } = harness();
    const mixer = jest
      .spyOn(internals, 'executeMixerCue')
      .mockResolvedValue(undefined);
    await internals.executeCue(
      'radio-1',
      cue({ kind: 'mixer', mixerChange: { channelId: 'main' } }),
    );
    await internals.executeCue('radio-1', cue({ kind: 'mixer' }));
    expect(mixer).toHaveBeenCalledTimes(1);
    expect(mixer).toHaveBeenCalledWith('radio-1', { channelId: 'main' });
  });

  it('treats waits as no-ops at execution time', async () => {
    const { internals, program } = harness();
    await internals.executeCue('radio-1', cue({ kind: 'wait' }));
    await internals.executeCue('radio-1', cue({ kind: 'waitForSongEnd' }));
    for (const fn of Object.values(program)) {
      expect(fn).not.toHaveBeenCalled();
    }
  });
});

describe('FlightService song playout', () => {
  const song = (extra: Record<string, unknown> = {}) => ({
    id: 101,
    enabled: true,
    audioUrl: 'https://media.test/101.mp3',
    title: 'Title',
    artist: 'Artist',
    coverUrl: null,
    durationMs: null,
    ...extra,
  });

  it('builds a manual sequence with empty cover and undefined duration for sparse songs', async () => {
    const { internals, prisma, program } = harness();
    prisma.song.findUnique.mockResolvedValue(song());
    await internals.executePlaySongCue('radio-1', {
      id: 'c',
      kind: 'playSong',
      songId: 101,
    });
    const bus = program.updateProgramAudioBus.mock.calls[0][0].songSequence;
    expect(bus.items).toEqual([
      expect.objectContaining({
        kind: 'preset',
        songId: 101,
        coverUrl: '',
        durationMs: undefined,
        audioUrl: 'https://media.test/101.mp3',
      }),
    ]);
    expect(bus.activeItemId).toBe(bus.items[0].id);
    expect(bus).toMatchObject({
      mode: 'manual',
      intervalMs: 4000,
      loop: false,
    });
  });

  it('passes the recorded voice track options to the catalog player', async () => {
    const { internals, prisma, program } = harness();
    prisma.song.findUnique.mockResolvedValue(song());
    await internals.executePlaySongCue('radio-1', {
      id: 'c',
      kind: 'playSong',
      songId: 101,
      voiceTrackInstantId: 9,
      voiceDuckGain: 0.4,
      voiceFadeInSeconds: 1,
      voiceFadeOutSeconds: 2,
    });
    expect(program.takeCatalogSongOnAir).toHaveBeenCalledWith(
      'radio-1',
      expect.objectContaining({ id: 101 }),
      { instantId: 9, duckGain: 0.4, fadeInSeconds: 1, fadeOutSeconds: 2 },
    );
  });

  it.each([
    ['no song id', null, { id: 'c', kind: 'playSong' }],
    ['a missing song', null, { id: 'c', kind: 'playSong', songId: 101 }],
    [
      'a disabled song',
      song({ enabled: false }),
      { id: 'c', kind: 'playSong', songId: 101 },
    ],
    [
      'a song without audio',
      song({ audioUrl: '  ' }),
      { id: 'c', kind: 'playSong', songId: 101 },
    ],
  ])('refuses %s', async (_name, found, cue) => {
    const { internals, prisma, program } = harness();
    prisma.song.findUnique.mockResolvedValue(found);
    await expect(internals.executePlaySongCue('radio-1', cue)).rejects.toThrow(
      new BadRequestException('scheduled song is unavailable'),
    );
    expect(program.takeCatalogSongOnAir).not.toHaveBeenCalled();
  });
});

describe('FlightService scene updates', () => {
  const updated = { id: 3, metadata: '{}', layout: {} };

  function setup(metadata: string | null) {
    const h = harness();
    h.prisma.scene.findUnique.mockResolvedValue({ id: 3, metadata });
    h.prisma.scene.update.mockResolvedValue(updated);
    h.program.getProgramIdsByAssignedScene.mockResolvedValue(['p1', 'p2']);
    return h;
  }

  it('does nothing for a missing scene', async () => {
    const { internals, prisma, program } = harness();
    prisma.scene.findUnique.mockResolvedValue(null);
    await internals.executeSceneUpdateCue(3, { a: 1 });
    expect(prisma.scene.update).not.toHaveBeenCalled();
    expect(program.broadcastUpdate).not.toHaveBeenCalled();
  });

  it('deep-merges the patch into stored metadata and broadcasts to assigned programs', async () => {
    const h = setup(
      JSON.stringify({ keep: 1, nested: { a: 1, b: 2 }, drop: true, arr: [1] }),
    );
    await h.internals.executeSceneUpdateCue(3, {
      nested: { b: 3, c: 4 },
      drop: undefined,
      arr: { x: 1 },
      fresh: 'new',
    });
    expect(h.prisma.scene.update).toHaveBeenCalledWith({
      where: { id: 3 },
      data: {
        metadata: JSON.stringify({
          keep: 1,
          nested: { a: 1, b: 3, c: 4 },
          arr: { x: 1 },
          fresh: 'new',
        }),
      },
      include: { layout: true },
    });
    expect(h.program.getProgramIdsByAssignedScene).toHaveBeenCalledWith(3);
    expect(h.program.broadcastUpdate).toHaveBeenCalledTimes(2);
    expect(h.program.broadcastUpdate).toHaveBeenCalledWith('p1', {
      type: 'scene_update',
      scene: updated,
    });
    expect(h.program.broadcastUpdate).toHaveBeenCalledWith('p2', {
      type: 'scene_update',
      scene: updated,
    });
  });

  it.each([
    ['empty metadata', null],
    ['an array', '[1,2]'],
    ['a scalar', '5'],
    ['malformed JSON', '{oops'],
  ])('starts from an empty object for %s', async (_name, metadata) => {
    const h = setup(metadata);
    await h.internals.executeSceneUpdateCue(3, { a: 1 });
    expect(h.prisma.scene.update.mock.calls[0][0].data.metadata).toBe(
      '{"a":1}',
    );
  });
});

describe('FlightService mixer cues', () => {
  function setup(mixerSettings: unknown) {
    const h = harness();
    h.program.getProgramAudioBus.mockResolvedValue({ mixerSettings });
    return h;
  }

  it.each([
    ['missing settings', undefined],
    ['null settings', null],
    ['string settings', 'x'],
  ])('ignores %s', async (_name, settings) => {
    const { internals, program } = setup(settings);
    await internals.executeMixerCue('radio-1', {
      channelId: 'main',
      volume: 1,
    });
    expect(program.updateProgramAudioBus).not.toHaveBeenCalled();
  });

  it('sets the main master volume', async () => {
    const { internals, program } = setup({});
    await internals.executeMixerCue('radio-1', {
      channelId: 'main',
      volume: 60,
    });
    expect(program.getProgramAudioBus).toHaveBeenCalledWith('radio-1');
    expect(program.updateProgramAudioBus).toHaveBeenCalledWith(
      { mixerSettings: { mainMasterVolume: 60 } },
      'radio-1',
    );
  });

  it('changes nothing for a main change without a volume or without a channel', async () => {
    const { internals, program } = setup({});
    await internals.executeMixerCue('radio-1', { channelId: 'main' });
    await internals.executeMixerCue('radio-1', { volume: 5, muted: true });
    expect(program.updateProgramAudioBus).not.toHaveBeenCalled();
  });

  it('patches only the matching channel, tolerating malformed entries', async () => {
    const { internals, program } = setup({
      mixerChannels: [
        { id: 'song', volume: 10, muted: false, solo: false, extra: 1 },
        { id: 'stream', volume: 20 },
        'junk',
      ],
    });
    await internals.executeMixerCue('radio-1', {
      channelId: 'song',
      volume: 55,
      muted: true,
      solo: true,
    });
    expect(program.updateProgramAudioBus).toHaveBeenCalledWith(
      {
        mixerSettings: {
          mixerChannels: [
            { id: 'song', volume: 55, muted: true, solo: true, extra: 1 },
            { id: 'stream', volume: 20 },
            {},
          ],
        },
      },
      'radio-1',
    );
  });

  it('leaves unspecified channel fields alone and handles a missing channel list', async () => {
    const withChannel = setup({
      mixerChannels: [{ id: 'song', volume: 10, muted: false }],
    });
    await withChannel.internals.executeMixerCue('radio-1', {
      channelId: 'song',
    });
    expect(
      withChannel.program.updateProgramAudioBus.mock.calls[0][0].mixerSettings
        .mixerChannels,
    ).toEqual([{ id: 'song', volume: 10, muted: false }]);

    const noList = setup({ mixerChannels: 'bad' });
    await noList.internals.executeMixerCue('radio-1', {
      channelId: 'instants',
      volume: 1,
    });
    expect(noList.program.updateProgramAudioBus).toHaveBeenCalledWith(
      { mixerSettings: { mixerChannels: [] } },
      'radio-1',
    );
  });
});

describe('FlightService persistence and broadcast helpers', () => {
  it('persists the active cue id, or null past the end', async () => {
    const { internals, prisma } = harness();
    await internals.persistRuntimeState(runtimeState());
    await internals.persistRuntimeState(
      runtimeState({ activeIndex: 9, isRunning: false }),
    );
    expect(prisma.flightSequence.update).toHaveBeenNthCalledWith(1, {
      where: { id: 7 },
      data: { isRunning: true, activeItemId: 'a' },
    });
    expect(prisma.flightSequence.update).toHaveBeenNthCalledWith(2, {
      where: { id: 7 },
      data: { isRunning: false, activeItemId: null },
    });
  });

  it('broadcasts an explicit active id with the runtime snapshot', async () => {
    const { internals, prisma, program } = harness();
    internals.runtimes.set(
      'radio-1',
      runtimeState({ loop: true, waitingForSongEnd: true, activeIndex: 1 }),
    );
    await internals.broadcastFlightUpdate('radio-1', 12);
    expect(prisma.programState.findUnique).not.toHaveBeenCalled();
    expect(program.broadcastUpdate).toHaveBeenCalledWith('radio-1', {
      type: 'flight_update',
      programId: 'radio-1',
      activeSequenceId: 12,
      runtime: {
        sequenceId: 7,
        activeIndex: 1,
        isRunning: true,
        waitingForSongEnd: true,
        activeItemId: 'b',
        totalItems: 3,
        loop: true,
      },
    });
  });

  it('broadcasts a null active id and a null runtime', async () => {
    const { internals, program } = harness();
    await internals.broadcastFlightUpdate('radio-1', null);
    expect(program.broadcastUpdate).toHaveBeenCalledWith('radio-1', {
      type: 'flight_update',
      programId: 'radio-1',
      activeSequenceId: null,
      runtime: null,
    });
  });

  it('looks up the active id when none is given, tolerating a missing state', async () => {
    const { internals, prisma, program } = harness();
    await internals.broadcastFlightUpdate('radio-1');
    expect(prisma.programState.findUnique).toHaveBeenCalledWith({
      where: { programId: 'radio-1' },
      select: { activeFlightSequenceId: true },
    });
    expect(program.broadcastUpdate.mock.calls[0][1].activeSequenceId).toBe(7);
    prisma.programState.findUnique.mockResolvedValue(null);
    await internals.broadcastFlightUpdate('radio-1');
    expect(
      program.broadcastUpdate.mock.calls[1][1].activeSequenceId,
    ).toBeNull();
    prisma.programState.findUnique.mockResolvedValue({
      activeFlightSequenceId: null,
    });
    await internals.broadcastFlightUpdate('radio-1');
    expect(
      program.broadcastUpdate.mock.calls[2][1].activeSequenceId,
    ).toBeNull();
  });

  it('reports a null active item when the cursor is out of range', async () => {
    const { internals, program } = harness();
    internals.runtimes.set('radio-1', runtimeState({ activeIndex: 9 }));
    await internals.broadcastFlightUpdate('radio-1', 1);
    expect(
      program.broadcastUpdate.mock.calls[0][1].runtime.activeItemId,
    ).toBeNull();
  });

  it('clears an armed timer only when there is one', () => {
    jest.useFakeTimers();
    const { internals } = harness();
    const armed = runtimeState({ timer: setTimeout(() => undefined, 1000) });
    internals.clearTimer(armed);
    expect(armed.timer).toBeNull();
    expect(jest.getTimerCount()).toBe(0);
    const idle = runtimeState();
    internals.clearTimer(idle);
    expect(idle.timer).toBeNull();
  });
});

describe('FlightService dependency metadata', () => {
  it('resolves the circular ProgramService dependency lazily', () => {
    const injected = Reflect.getMetadata('self:paramtypes', FlightService) as {
      index: number;
      param: { forwardRef: () => unknown };
    }[];
    const entry = injected.find((item) => item.index === 1);
    expect(entry?.param.forwardRef()).toBe(ProgramService);
  });
});

describe('FlightService cue operation queue', () => {
  it('runs cue executions for a program one at a time, in order', async () => {
    const { internals } = harness();
    const order: string[] = [];
    let releaseFirst!: () => void;
    jest
      .spyOn(internals, 'executeCueAtIndexUnlocked')
      .mockImplementationOnce(async () => {
        order.push('first-start');
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
        order.push('first-end');
      })
      .mockImplementationOnce(async () => {
        order.push('second');
      });
    const first = internals.executeCueAtIndex('radio-1', 0, 1);
    const second = internals.executeCueAtIndex('radio-1', 1, 1);
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(order).toEqual(['first-start']);
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(['first-start', 'first-end', 'second']);
    expect(internals.executeCueAtIndexUnlocked).toHaveBeenNthCalledWith(
      2,
      'radio-1',
      1,
      1,
    );
    expect(internals.cueOperations.size).toBe(0);
  });
});

describe('FlightService module load without injectable classes', () => {
  it('records Object parameter metadata when a dependency class is not yet defined', () => {
    jest.isolateModules(() => {
      jest.doMock('../prisma.service', () => ({ PrismaService: undefined }));
      jest.doMock('./program.service', () => ({ ProgramService: undefined }));
      jest.doMock('../radio/radio-metrics.service', () => ({
        RadioMetricsService: undefined,
      }));
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const loaded = require('./flight.service') as {
        FlightService: new (...args: never[]) => unknown;
      };
      expect(
        Reflect.getMetadata('design:paramtypes', loaded.FlightService),
      ).toEqual([Object, Object, Object]);
    });
    jest.dontMock('../prisma.service');
    jest.dontMock('./program.service');
    jest.dontMock('../radio/radio-metrics.service');
  });
});
