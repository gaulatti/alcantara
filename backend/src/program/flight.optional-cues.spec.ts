import { Logger } from '@nestjs/common';
import { FlightService } from './flight.service';
import { RadioMetricsService } from '../radio/radio-metrics.service';

function fixture(items: unknown[]) {
  const state = { id: 1, programId: 'news', activeFlightSequenceId: 7 };
  const sequence = {
    id: 7,
    programStateId: 1,
    name: 'Legacy rundown',
    items,
    isRunning: false,
    loop: false,
    activeItemId: null,
    scheduledAt: null,
  };
  const prisma: any = {
    programState: {
      findUnique: jest.fn().mockResolvedValue(state),
      update: jest.fn(async ({ data }) => Object.assign(state, data)),
    },
    flightSequence: {
      findUnique: jest.fn().mockResolvedValue(sequence),
      update: jest.fn(async ({ data }) => Object.assign(sequence, data)),
    },
  };
  const channels = [
    { id: 'song', volume: 1, muted: false, solo: false },
    { id: 'instants', volume: 1, muted: false, solo: false },
  ];
  const programs: any = {
    broadcastUpdate: jest.fn(),
    takeProgramSongOffAir: jest.fn(),
    activateScene: jest.fn(),
    playInstant: jest.fn(),
    getProgramAudioBus: jest.fn().mockResolvedValue({
      mixerSettings: { mixerChannels: channels },
    }),
    updateProgramAudioBus: jest.fn(),
  };
  const service = new FlightService(
    prisma,
    programs,
    new RadioMetricsService(),
  );
  return { service, state, sequence, prisma, programs, channels };
}

describe('FlightService persisted optional cue fields', () => {
  const active: FlightService[] = [];
  const setup = (items: unknown[]) => {
    const result = fixture(items);
    active.push(result.service);
    return result;
  };
  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(console, 'log').mockImplementation();
    jest.spyOn(console, 'error').mockImplementation();
    jest.spyOn(Logger.prototype, 'error').mockImplementation();
  });
  afterEach(() => {
    for (const service of active.splice(0)) service.onModuleDestroy();
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('skips incomplete legacy action cues without inventing an asset or blocking the next timed cue', async () => {
    const f = setup([
      { id: 'scene', kind: 'scene' },
      { id: 'patch', kind: 'sceneUpdate', sceneId: 3 },
      { id: 'instant', kind: 'instant' },
      { id: 'mixer', kind: 'mixer' },
      { id: 'song', kind: 'playSong' },
      { id: 'wait', kind: 'wait', durationMs: 1000 },
    ]);
    await f.service.start('news');
    await jest.advanceTimersByTimeAsync(0);
    expect(f.sequence.activeItemId).toBe('wait');
    expect(f.sequence.isRunning).toBe(true);
    expect(f.programs.activateScene).not.toHaveBeenCalled();
    expect(f.programs.playInstant).not.toHaveBeenCalled();
    expect(f.programs.updateProgramAudioBus).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(
      'Flight cue execution failed (playSong)',
      expect.objectContaining({ message: 'scheduled song is unavailable' }),
    );
    await jest.advanceTimersByTimeAsync(1000);
    expect(f.sequence.isRunning).toBe(false);
  });

  it.each([
    [{ muted: true }, { volume: 1, muted: true, solo: false }],
    [{ solo: true }, { volume: 1, muted: false, solo: true }],
    [{ volume: 0 }, { volume: 0, muted: false, solo: false }],
  ])('changes only the supplied mixer field: %p', async (patch, expected) => {
    const f = setup([
      {
        id: 'mix',
        kind: 'mixer',
        mixerChange: { channelId: 'song', ...patch },
      },
      { id: 'wait', kind: 'wait', durationMs: 1000 },
    ]);
    await f.service.start('news');
    await jest.advanceTimersByTimeAsync(0);
    expect(f.programs.updateProgramAudioBus).toHaveBeenCalledWith(
      {
        mixerSettings: {
          mixerChannels: [
            { id: 'song', ...expected },
            { id: 'instants', volume: 1, muted: false, solo: false },
          ],
        },
      },
      'news',
    );
    expect(f.channels[0]).toEqual({
      id: 'song',
      volume: 1,
      muted: false,
      solo: false,
    });
  });

  it('treats an empty mixer action as a no-op and still runs the following wait', async () => {
    const f = setup([
      { id: 'mix', kind: 'mixer', mixerChange: {} },
      { id: 'wait', kind: 'wait', durationMs: 1000 },
    ]);
    await f.service.start('news');
    await jest.advanceTimersByTimeAsync(0);
    expect(f.programs.updateProgramAudioBus).not.toHaveBeenCalled();
    expect(f.sequence.activeItemId).toBe('wait');
  });

  it('resets an idle program with no selected sequence without writing a nonexistent sequence', async () => {
    const f = setup([]);
    f.state.activeFlightSequenceId = null as any;
    expect(await f.service.reset('news')).toEqual({ ok: true });
    expect(f.prisma.flightSequence.update).not.toHaveBeenCalled();
    expect(f.programs.broadcastUpdate).toHaveBeenLastCalledWith(
      'news',
      expect.objectContaining({ activeSequenceId: null, runtime: null }),
    );
  });
});
