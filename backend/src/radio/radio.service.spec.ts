import { BadRequestException } from '@nestjs/common';
import { RadioService } from './radio.service';
import { createHash } from 'node:crypto';
import { RadioMetricsService } from './radio-metrics.service';

describe('RadioService settings', () => {
  it('persists every bumper field exposed by the radio console', async () => {
    const prisma = {
      programState: { findUnique: jest.fn().mockResolvedValue({ id: 10 }) },
      radioSettings: {
        upsert: jest.fn().mockImplementation(({ update }) => update),
      },
    } as any;
    const service = new RadioService(
      prisma,
      {} as any,
      {} as any,
      new RadioMetricsService(),
    );

    const result = await service.updateRadioSettings('palazzo', {
      bumperEnabled: true,
      bumperInterval: 3,
      bumperInstantIds: [8, 4, 8],
      bumperMode: 'random',
    });

    expect(result).toMatchObject({
      bumperEnabled: true,
      bumperInterval: 3,
      bumperInstantIds: [8, 4],
      bumperMode: 'random',
    });
  });

  it('routes every radio operation through the shared machine client', async () => {
    const prisma = {
      programState: {
        findUnique: jest.fn().mockResolvedValue({
          radioSettings: { palazzoUrl: 'http://palazzo:3100' },
        }),
      },
    } as any;
    const palazzo = {
      playSong: jest.fn().mockResolvedValue({ playbackRequestId: 'song-1' }),
      stopSong: jest.fn().mockResolvedValue(undefined),
      playInstant: jest
        .fn()
        .mockResolvedValue({ playbackRequestId: 'instant-1' }),
      stopInstants: jest.fn().mockResolvedValue(undefined),
      updateMixer: jest.fn().mockResolvedValue({}),
      getPlaybackState: jest.fn().mockResolvedValue({
        liquidsoap: { running: true, connected: true },
        icecast: { connected: true },
      }),
    } as any;
    const service = new RadioService(
      prisma,
      palazzo,
      {} as any,
      new RadioMetricsService(),
    );

    await expect(
      service.playSong(
        'radio-1',
        'https://media.example/song.mp3',
        'Song',
        'Artist',
        'song-1',
      ),
    ).resolves.toMatchObject({ ok: true, playbackRequestId: 'song-1' });
    await service.stopSong('radio-1');
    await service.playInstant(
      'radio-1',
      'https://media.example/instant.mp3',
      0.5,
      'instant-1',
    );
    await service.stopAllInstants('radio-1');
    await service.updateMixer('radio-1', {
      mainVolume: 1,
      songVolume: 0.8,
      instantVolume: 0.7,
      songMuted: false,
      instantMuted: false,
    });
    await expect(service.getPalazzoStatus('radio-1')).resolves.toEqual({
      running: true,
      uptime: null,
    });

    expect(palazzo.playSong).toHaveBeenCalledWith(
      'http://palazzo:3100',
      'radio-1',
      expect.objectContaining({ playbackId: 'song-1' }),
    );
    expect(palazzo.stopSong).toHaveBeenCalled();
    expect(palazzo.playInstant).toHaveBeenCalledWith(
      'http://palazzo:3100',
      'radio-1',
      expect.objectContaining({ playbackId: 'instant-1' }),
    );
    expect(palazzo.stopInstants).toHaveBeenCalled();
    expect(palazzo.updateMixer).toHaveBeenCalled();
    expect(palazzo.getPlaybackState).toHaveBeenCalled();
  });

  it('rejects an invalid bumper interval', async () => {
    const prisma = {
      programState: { findUnique: jest.fn().mockResolvedValue({ id: 10 }) },
      radioSettings: { upsert: jest.fn() },
    } as any;
    const service = new RadioService(
      prisma,
      {} as any,
      {} as any,
      new RadioMetricsService(),
    );
    await expect(
      service.updateRadioSettings('palazzo', { bumperInterval: 0 }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('RadioService recovery playlist', () => {
  it('verifies managed audio, prepares Palazzo, then persists the ready version', async () => {
    const settings = {
      id: 9,
      palazzoUrl: 'http://palazzo:3100',
      fillerSongIds: [] as number[],
      fillerVersion: null as string | null,
    };
    const prisma = {
      programState: {
        findUnique: jest
          .fn()
          .mockImplementation(async () => ({ radioSettings: settings })),
      },
      song: {
        findMany: jest
          .fn()
          .mockResolvedValue([
            {
              id: 5,
              enabled: true,
              audioUrl: 'https://media-test.s3.amazonaws.com/song.mp3',
            },
          ]),
      },
      radioSettings: {
        update: jest
          .fn()
          .mockImplementation(async ({ data }) =>
            Object.assign(settings, data),
          ),
      },
    } as any;
    const palazzo = {
      prepareFiller: jest.fn().mockResolvedValue(undefined),
      getAutomation: jest
        .fn()
        .mockResolvedValue({
          lastSequence: 1,
          requestedState: 'stopped',
          actualState: 'stopped',
          filler: { activeVersion: null, ready: false },
        }),
    } as any;
    const config = {
      get: (key: string) =>
        key === 'MEDIA_S3_BUCKET' ? 'media-test' : 'us-east-1',
    } as any;
    const request = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('fixture audio'));
    try {
      const metrics = new RadioMetricsService();
      const result = await new RadioService(
        prisma,
        palazzo,
        config,
        metrics,
      ).prepareRecoveryPlaylist('radio-1', [5]);
      expect(result.selectedSongIds).toEqual([5]);
      expect(palazzo.prepareFiller).toHaveBeenCalledWith(
        'http://palazzo:3100',
        'radio-1',
        expect.stringMatching(/^filler-/),
        [
          {
            id: 'song-5',
            sha256: createHash('sha256').update('fixture audio').digest('hex'),
            downloadUrl: 'https://media-test.s3.amazonaws.com/song.mp3',
          },
        ],
      );
      expect(
        prisma.radioSettings.update.mock.invocationCallOrder[0],
      ).toBeGreaterThan(palazzo.prepareFiller.mock.invocationCallOrder[0]);
      expect(metrics.render()).toContain(
        'alcantara_radio_recovery_preparations_total{result="ready"} 1',
      );
    } finally {
      request.mockRestore();
    }
  });

  it('rejects off-bucket URLs before downloading or preparing', async () => {
    const prisma = {
      programState: {
        findUnique: jest
          .fn()
          .mockResolvedValue({
            radioSettings: { id: 9, palazzoUrl: 'http://palazzo:3100' },
          }),
      },
      song: {
        findMany: jest
          .fn()
          .mockResolvedValue([
            { id: 5, enabled: true, audioUrl: 'http://internal.test/audio' },
          ]),
      },
    } as any;
    const palazzo = { prepareFiller: jest.fn() } as any;
    const request = jest.spyOn(globalThis, 'fetch');
    try {
      const metrics = new RadioMetricsService();
      await expect(
        new RadioService(
          prisma,
          palazzo,
          { get: () => 'media-test' } as any,
          metrics,
        ).prepareRecoveryPlaylist('radio-1', [5]),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(request).not.toHaveBeenCalled();
      expect(palazzo.prepareFiller).not.toHaveBeenCalled();
      expect(metrics.render()).toContain(
        'alcantara_radio_recovery_preparations_total{result="failed"} 1',
      );
    } finally {
      request.mockRestore();
    }
  });
});
