/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return */
import { noRecorder } from '../operator-change/operator-change-recorder.testing';
import {
  AutomationEngineUnavailableError,
  isRadioOnlyEngineOff,
} from '../radio/engine-availability';
import { RadioMetricsService } from '../radio/radio-metrics.service';
import { FlightService } from './flight.service';

// gaulatti/alcantara#609: with a radio-only program's engine off, a rundown song is not started
// (no audio bus write, no engine take). It is logged as not aired, counted, and the block ends.

const song = {
  id: 101,
  enabled: true,
  audioUrl: 'https://media.test/101.mp3',
  title: 'Harbor Lights',
  artist: 'Marisol Vega',
  coverUrl: null,
  durationMs: 214_000,
};

function harness(programState: unknown) {
  const prisma = {
    programState: { findUnique: jest.fn().mockResolvedValue(programState) },
    song: { findUnique: jest.fn().mockResolvedValue(song) },
    asRunRecord: { create: jest.fn().mockResolvedValue({}) },
    flightSequence: { update: jest.fn().mockResolvedValue({}) },
  };
  const program = {
    broadcastUpdate: jest.fn(),
    updateProgramAudioBus: jest.fn().mockResolvedValue(undefined),
    takeCatalogSongOnAir: jest.fn(),
    stopProgramSongForTimedBlock: jest.fn().mockResolvedValue(undefined),
  };
  const metrics = new RadioMetricsService();
  const service = new FlightService(
    prisma as any,
    program as any,
    metrics,
    noRecorder(),
    { teamId: 0 } as never,
  );
  return { prisma, program, metrics, internals: service as any };
}

const refusedCount = (metrics: RadioMetricsService) =>
  Number(
    metrics
      .render()
      .split('\n')
      .find((row) =>
        row.startsWith(
          'alcantara_radio_start_refused_total{reason="automation_engine_unavailable"} ',
        ),
      )
      ?.split(' ')[1],
  );

afterEach(() => jest.restoreAllMocks());

describe('isRadioOnlyEngineOff', () => {
  it.each([
    [{ type: 'radio', radioSettings: { enabled: false } }, true],
    [{ type: 'radio', radioSettings: null }, true],
    [{ type: 'radio', radioSettings: { enabled: true } }, false],
    [{ type: 'both', radioSettings: { enabled: false } }, false],
    [{ type: 'tv', radioSettings: null }, false],
    [null, false],
  ])('%j is off: %p', async (state, off) => {
    const prisma = {
      programState: { findUnique: jest.fn().mockResolvedValue(state) },
    };
    await expect(isRadioOnlyEngineOff(prisma as any, 'station')).resolves.toBe(
      off,
    );
    expect(prisma.programState.findUnique).toHaveBeenCalledWith({
      where: { programId: 'station' },
      select: { type: true, radioSettings: { select: { enabled: true } } },
    });
  });

  it('names its reason on the error', () => {
    const error = new AutomationEngineUnavailableError();
    expect(error.reason).toBe('engine_unavailable');
    expect(error.message).toBe(
      'The radio engine is off (disabled in settings); the song was not aired.',
    );
  });
});

describe('rundown song with the engine off', () => {
  it('starts nothing, logs the song as not aired, and counts it', async () => {
    const h = harness({ type: 'radio', radioSettings: { enabled: false } });
    expect(refusedCount(h.metrics)).toBe(0);
    await expect(
      h.internals.executePlaySongCue('radio-1', {
        id: 'a',
        kind: 'playSong',
        songId: 101,
      }),
    ).rejects.toBeInstanceOf(AutomationEngineUnavailableError);
    expect(h.program.updateProgramAudioBus).not.toHaveBeenCalled();
    expect(h.program.takeCatalogSongOnAir).not.toHaveBeenCalled();
    expect(h.prisma.asRunRecord.create).toHaveBeenCalledWith({
      data: {
        programId: 'radio-1',
        songId: 101,
        state: 'not-aired',
        endReason: 'engine_unavailable',
        at: expect.any(Date),
        flightSequenceId: null,
        flightCueId: null,
      },
    });
    expect(refusedCount(h.metrics)).toBe(1);
  });

  it('names the rundown and cue it skipped, so the rundown shows it as skipped (#726)', async () => {
    const h = harness({ type: 'radio', radioSettings: { enabled: false } });
    h.internals.runtimes.set('radio-1', { sequenceId: 7 });
    await expect(
      h.internals.executePlaySongCue('radio-1', {
        id: 'top-of-hour',
        kind: 'playSong',
        songId: 101,
      }),
    ).rejects.toBeInstanceOf(AutomationEngineUnavailableError);
    expect(h.prisma.asRunRecord.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        state: 'not-aired',
        flightSequenceId: 7,
        flightCueId: 'top-of-hour',
      }),
    });
  });

  it.each([
    ['a TV program', { type: 'tv', radioSettings: null }],
    [
      'a simulcast program with its engine off',
      { type: 'both', radioSettings: { enabled: false } },
    ],
    [
      'a radio program with its engine on',
      { type: 'radio', radioSettings: { enabled: true } },
    ],
  ])('plays as before for %s', async (_, state) => {
    const h = harness(state);
    await h.internals.executePlaySongCue('radio-1', {
      id: 'a',
      kind: 'playSong',
      songId: 101,
    });
    expect(h.program.takeCatalogSongOnAir).toHaveBeenCalledTimes(1);
    expect(h.prisma.asRunRecord.create).not.toHaveBeenCalled();
    expect(refusedCount(h.metrics)).toBe(0);
  });

  it.each([
    ['a scheduled block', 1_700_000_000_000],
    ['a manually run rundown', null],
  ])(
    'ends %s with the reason instead of running it silently',
    async (_, scheduledAtMs) => {
      const h = harness({ type: 'radio', radioSettings: { enabled: false } });
      const recorded = jest.spyOn(h.metrics, 'recordRadioLogResult');
      const stop = jest.spyOn(h.internals, 'stop').mockResolvedValue(undefined);
      jest
        .spyOn(h.internals, 'persistRuntimeState')
        .mockResolvedValue(undefined);
      jest
        .spyOn(h.internals, 'broadcastFlightUpdate')
        .mockResolvedValue(undefined);
      const advance = jest
        .spyOn(h.internals, 'advance')
        .mockResolvedValue(undefined);
      jest.spyOn(console, 'error').mockImplementation(() => undefined);
      h.internals.runtimes.set('radio-1', {
        sequenceId: 7,
        programId: 'radio-1',
        items: [
          { id: 'a', kind: 'playSong', songId: 101 },
          { id: 'b', kind: 'waitForSongEnd' },
        ],
        loop: false,
        activeIndex: 0,
        isRunning: true,
        generation: 1,
        timer: null,
        waitingForSongEnd: false,
        startedAt: Date.now(),
        scheduledAtMs,
      });
      await h.internals.executeCueAtIndexUnlocked('radio-1', 0, 1);
      expect(stop).toHaveBeenCalledWith('radio-1', { flightDriven: true });
      expect(h.program.broadcastUpdate).toHaveBeenCalledWith('radio-1', {
        type: 'radio_log_cue_failed',
        sequenceId: 7,
        cueId: 'a',
        reason: 'engine_unavailable',
      });
      expect(recorded).not.toHaveBeenCalledWith('cue-failed');
      expect(advance).not.toHaveBeenCalled();
      expect(console.error).not.toHaveBeenCalled();
    },
  );
});
