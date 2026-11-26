/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return */
import { FlightService } from './flight.service';
import { RadioMetricsService } from '../radio/radio-metrics.service';
import { noRecorder } from '../operator-change/operator-change-recorder.testing';

// The airing walk's W3: a fixed start cut the song on air and jumped over the next song, which never aired. With no
// as-run row the rundown showed it as played. Each song cue a fixed start passes over is now logged as not aired
// (reason `fixed_start`) with its cue, so the rundown shows it as skipped (#726); the fixed cue is started first.

const FIXED_S = 60;

function harness(items: any[], active: any = {}) {
  jest.useFakeTimers();
  const prisma = {
    asRunRecord: { create: jest.fn().mockResolvedValue({}) },
  };
  const program = { broadcastUpdate: jest.fn() };
  const metrics = new RadioMetricsService();
  const recorded = jest.spyOn(metrics, 'recordRadioLogResult');
  const service = new FlightService(
    prisma as any,
    program as any,
    metrics,
    noRecorder(),
    { teamId: 0 } as never,
  );
  const internals = service as any;
  const logError = jest
    .spyOn(internals.logger, 'error')
    .mockImplementation(() => undefined);
  const executeCueAtIndex = jest
    .spyOn(internals, 'executeCueAtIndex')
    .mockResolvedValue(undefined);
  const scheduledAtMs = Date.now();
  const runtime: any = {
    sequenceId: 7,
    programId: 'radio-1',
    items,
    loop: false,
    activeIndex: 0,
    isRunning: true,
    generation: 1,
    timer: null,
    waitingForSongEnd: true,
    scheduledAtMs,
    ...active,
  };
  internals.runtimes.set('radio-1', runtime);
  return {
    prisma,
    program,
    recorded,
    internals,
    executeCueAtIndex,
    logError,
    runtime,
  };
}

async function settle() {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

const notAired = (songId: number, cueId: string) => ({
  data: {
    programId: 'radio-1',
    songId,
    state: 'not-aired',
    endReason: 'fixed_start',
    at: expect.any(Date),
    flightSequenceId: 7,
    flightCueId: cueId,
  },
});

describe('cues a fixed start passes over (W3)', () => {
  it('starts the fixed cue and logs each song it passed over as not aired, reason fixed_start', async () => {
    const h = harness([
      { id: 'opener', kind: 'playSong', songId: 3, clockOffsetSeconds: 0 },
      { id: 'second', kind: 'playSong', songId: 4 },
      { id: 'clip', kind: 'instant', instantId: 9, durationMs: 5_000 },
      { id: 'top', kind: 'playSong', songId: 5, clockOffsetSeconds: FIXED_S },
    ]);
    h.internals.armNextHardCue(h.runtime);
    jest.advanceTimersByTime(FIXED_S * 1000);
    await settle();
    expect(h.executeCueAtIndex).toHaveBeenCalledWith('radio-1', 3, 2, 'fixed_start');
    expect(h.prisma.asRunRecord.create).toHaveBeenCalledTimes(1);
    expect(h.prisma.asRunRecord.create).toHaveBeenCalledWith(
      notAired(4, 'second'),
    );
    // Every cue passed over is skipped on the desk; a clip has no as-run row of its own.
    for (const cueId of ['second', 'clip'])
      expect(h.program.broadcastUpdate).toHaveBeenCalledWith('radio-1', {
        type: 'radio_log_cue_skipped',
        sequenceId: 7,
        cueId,
      });
    expect(
      h.recorded.mock.calls.filter(([result]) => result === 'cue-skipped'),
    ).toHaveLength(2);
  });

  it('logs nothing when the fixed cue is the next one', async () => {
    const h = harness([
      { id: 'opener', kind: 'playSong', songId: 3, clockOffsetSeconds: 0 },
      { id: 'top', kind: 'playSong', songId: 5, clockOffsetSeconds: FIXED_S },
    ]);
    h.internals.armNextHardCue(h.runtime);
    jest.advanceTimersByTime(FIXED_S * 1000);
    await settle();
    // The song on air is still cut by the fixed start.
    expect(h.executeCueAtIndex).toHaveBeenCalledWith('radio-1', 1, 2, 'fixed_start');
    expect(h.prisma.asRunRecord.create).not.toHaveBeenCalled();
    expect(h.program.broadcastUpdate).not.toHaveBeenCalled();
  });

  it('logs the songs a timed clip running into a fixed start passes over', async () => {
    const h = harness(
      [
        { id: 'clip', kind: 'instant', instantId: 9, durationMs: 120_000, clockOffsetSeconds: 0 },
        { id: 'second', kind: 'playSong', songId: 4 },
        { id: 'top', kind: 'playSong', songId: 5, clockOffsetSeconds: FIXED_S },
      ],
      { waitingForSongEnd: false, cueStartedAt: Date.now() },
    );
    h.internals.armTimedClip(h.runtime);
    jest.advanceTimersByTime(FIXED_S * 1000);
    await settle();
    expect(h.executeCueAtIndex).toHaveBeenCalledWith('radio-1', 2, 1, 'fixed_start');
    expect(h.prisma.asRunRecord.create).toHaveBeenCalledWith(
      notAired(4, 'second'),
    );
  });

  it('keeps the block going when a not-aired row cannot be written', async () => {
    const h = harness([
      { id: 'opener', kind: 'playSong', songId: 3, clockOffsetSeconds: 0 },
      { id: 'second', kind: 'playSong', songId: 4 },
      { id: 'third', kind: 'playSong', songId: 6 },
      { id: 'top', kind: 'playSong', songId: 5, clockOffsetSeconds: FIXED_S },
    ]);
    h.prisma.asRunRecord.create.mockRejectedValueOnce(new Error('db down'));
    h.internals.armNextHardCue(h.runtime);
    jest.advanceTimersByTime(FIXED_S * 1000);
    await settle();
    expect(h.executeCueAtIndex).toHaveBeenCalledWith('radio-1', 3, 2, 'fixed_start');
    expect(h.logError).toHaveBeenCalledWith(
      'Could not log a cue passed over by a fixed start as not aired for radio-1',
      expect.any(Error),
    );
    // The next song is still logged after the failed one.
    expect(h.prisma.asRunRecord.create).toHaveBeenLastCalledWith(
      notAired(6, 'third'),
    );
  });
});

describe("a fixed start's cut is the song's end reason", () => {
  function playout(cutOrNot?: 'fixed_start') {
    const program = {
      broadcastUpdate: jest.fn(),
      stopProgramSongForTimedBlock: jest.fn().mockResolvedValue(undefined),
    };
    const service = new FlightService(
      { flightSequence: { update: jest.fn() } } as any,
      program as any,
      new RadioMetricsService(),
      noRecorder(),
      { teamId: 0 } as never,
    );
    const internals = service as any;
    jest.spyOn(internals, 'persistRuntimeState').mockResolvedValue(undefined);
    jest.spyOn(internals, 'broadcastFlightUpdate').mockResolvedValue(undefined);
    jest.spyOn(internals, 'executeCue').mockResolvedValue(undefined);
    jest.spyOn(internals, 'armNextHardCue').mockReturnValue(undefined);
    internals.runtimes.set('radio-1', {
      sequenceId: 7,
      programId: 'radio-1',
      items: [
        { id: 'opener', kind: 'playSong', songId: 3, clockOffsetSeconds: 0 },
        { id: 'top', kind: 'playSong', songId: 5 },
      ],
      loop: false,
      activeIndex: 0,
      isRunning: true,
      generation: 1,
      timer: null,
      waitingForSongEnd: true,
      scheduledAtMs: Date.now() - 1_000,
    });
    return { program, run: () => internals.executeCueAtIndex('radio-1', 1, 1, cutOrNot) };
  }

  it('stops the song for the timed block with fixed_start when a fixed start cuts it', async () => {
    const h = playout('fixed_start');
    await h.run();
    expect(h.program.stopProgramSongForTimedBlock).toHaveBeenCalledWith('radio-1', 'fixed_start');
  });

  it('stops it as before for an ordinary next cue', async () => {
    const h = playout();
    await h.run();
    expect(h.program.stopProgramSongForTimedBlock).toHaveBeenCalledWith('radio-1');
  });
});
