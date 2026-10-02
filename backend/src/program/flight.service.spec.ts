import { FlightService } from './flight.service';
import { RadioMetricsService } from '../radio/radio-metrics.service';

describe('FlightService song cues', () => {
  it('takes the catalog song on air after persisting the manual cue sequence', async () => {
    const song = {
      id: 101,
      audioUrl: 'https://example.test/song.mp3',
      title: 'Fictional song',
      artist: 'Fictional artist',
      coverUrl: 'https://example.test/cover.jpg',
      durationMs: 180_000,
      enabled: true,
    };
    const prisma = {
      song: { findUnique: jest.fn().mockResolvedValue(song) },
    };
    const programService = {
      updateProgramAudioBus: jest.fn().mockResolvedValue(undefined),
      takeCatalogSongOnAir: jest.fn(),
    };
    const service = new FlightService(
      prisma as any,
      programService as any,
      new RadioMetricsService(),
    );

    await (service as any).executePlaySongCue('radio-1', {
      id: 'cue-1',
      kind: 'playSong',
      songId: 101,
    });

    expect(programService.updateProgramAudioBus).toHaveBeenCalledWith(
      {
        songSequence: expect.objectContaining({
          mode: 'manual',
          activeItemId: expect.any(String),
          items: [expect.objectContaining({ songId: 101 })],
        }),
      },
      'radio-1',
    );
    expect(programService.takeCatalogSongOnAir).toHaveBeenCalledWith(
      'radio-1',
      song,
      undefined,
    );
    expect(
      programService.updateProgramAudioBus.mock.invocationCallOrder[0],
    ).toBeLessThan(
      programService.takeCatalogSongOnAir.mock.invocationCallOrder[0],
    );
  });
});

describe('FlightService clocked logs', () => {
  it('persists, preflights, and publishes a future radio hour at its expected revision', async () => {
    const scheduledAt = new Date(Date.now() + 3_600_000);
    scheduledAt.setUTCSeconds(0, 0);
    const cues = [
      { id: 'slot-1', kind: 'playSong', songId: 101, clockOffsetSeconds: 0 },
    ];
    const record = {
      id: 7,
      programStateId: 1,
      name: 'Next hour',
      items: cues,
      loop: false,
      isRunning: false,
      activeItemId: null,
      scheduledAt,
      publishedAt: null as Date | null,
      lastStartedAt: null,
      revision: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const prisma = {
      programState: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ id: 1, programId: 'radio-1', type: 'radio' }),
      },
      flightSequence: {
        create: jest.fn().mockResolvedValue(record),
        findFirst: jest.fn().mockImplementation(async () => record),
        updateMany: jest.fn().mockImplementation(async ({ data }) => {
          record.publishedAt = data.publishedAt;
          record.revision += 1;
          return { count: 1 };
        }),
        findUniqueOrThrow: jest.fn().mockImplementation(async () => record),
      },
      song: {
        findMany: jest
          .fn()
          .mockResolvedValue([
            {
              id: 101,
              enabled: true,
              audioUrl: 'https://media.test/song.mp3',
              durationMs: 120_000,
            },
          ]),
      },
      instant: { findMany: jest.fn().mockResolvedValue([]) },
    } as any;
    const metrics = new RadioMetricsService();
    const service = new FlightService(prisma, {} as any, metrics);
    await service.createFlightSequence('radio-1', {
      name: 'Next hour',
      scheduledAt: scheduledAt.toISOString(),
      items: cues,
    });
    expect((await service.preflightFlightSequence('radio-1', 7)).ready).toBe(
      true,
    );
    const published = await service.publishFlightSequence('radio-1', 7, 1);
    expect(published.publishedAt).toBeInstanceOf(Date);
    expect(published.revision).toBe(2);
    expect(metrics.render()).toContain(
      'alcantara_radio_log_transitions_total{result="published"} 1',
    );
  });

  it('rejects malformed clock fields and unavailable audio before publication', async () => {
    const scheduledAt = new Date(Date.now() + 3_600_000);
    scheduledAt.setUTCSeconds(0, 0);
    const record = {
      id: 7,
      programStateId: 1,
      name: 'Next hour',
      items: [
        { id: 'slot-1', kind: 'playSong', songId: 101, clockOffsetSeconds: 0 },
      ],
      loop: false,
      scheduledAt,
      revision: 1,
    };
    const prisma = {
      programState: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ id: 1, programId: 'radio-1', type: 'radio' }),
      },
      flightSequence: {
        create: jest.fn(),
        findFirst: jest.fn().mockResolvedValue(record),
        updateMany: jest.fn(),
      },
      song: {
        findMany: jest
          .fn()
          .mockResolvedValue([
            {
              id: 101,
              enabled: false,
              audioUrl: 'https://media.test/song.mp3',
            },
          ]),
      },
      instant: { findMany: jest.fn().mockResolvedValue([]) },
    } as any;
    const service = new FlightService(
      prisma,
      {} as any,
      new RadioMetricsService(),
    );
    await expect(
      service.createFlightSequence('radio-1', {
        name: 'Bad hour',
        scheduledAt: scheduledAt.toISOString(),
        items: [
          {
            id: 'slot-1',
            kind: 'playSong',
            songId: '101',
            clockOffsetSeconds: 0,
          },
        ],
      }),
    ).rejects.toThrow('songId must be a nonnegative integer');
    await expect(
      service.publishFlightSequence('radio-1', 7, 1),
    ).rejects.toThrow('song unavailable');
    expect(prisma.flightSequence.updateMany).not.toHaveBeenCalled();
  });
});
