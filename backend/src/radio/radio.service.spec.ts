import { BadRequestException } from '@nestjs/common';
import { RadioService } from './radio.service';
import { createHash } from 'node:crypto';
import { RadioMetricsService } from './radio-metrics.service';

/** The argument of a settings `update` call; the mock echoes its fields. */
type Update = { update: object };
/** The argument of a settings `update` by id; the mock merges its data. */
type Data = { data: object };
/** The argument of a settings upsert; tests read both halves back. */
type Upsert = { create: object; update: object };

describe('RadioService settings', () => {
  it('permits loopback listener fixtures locally and refuses them in production', async () => {
    const previousEnvironment = process.env.NODE_ENV;
    const prisma = {
      programState: { findUnique: jest.fn().mockResolvedValue({ id: 10 }) },
      radioSettings: {
        upsert: jest
          .fn()
          .mockImplementation(async ({ update }: Update) => update),
      },
    };
    const service = new RadioService(
      prisma as never,
      {} as never,
      {} as never,
      new RadioMetricsService(),
      { teamId: 0 } as never,
    );
    try {
      process.env.NODE_ENV = 'test';
      await expect(
        service.updateRadioSettings('radio', {
          listenerUrl: 'http://localhost:5177/fixture.ogg',
        }),
      ).resolves.toMatchObject({
        listenerUrl: 'http://localhost:5177/fixture.ogg',
      });
      process.env.NODE_ENV = 'production';
      await expect(
        service.updateRadioSettings('radio', {
          listenerUrl: 'http://localhost:5177/fixture.ogg',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    } finally {
      if (previousEnvironment === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousEnvironment;
    }
  });
  it('persists and clears listener URLs without altering existing playout settings and renders bounded outcomes', async () => {
    const settings: Record<string, unknown> = {
      palazzoUrl: 'http://palazzo:3100',
      enabled: true,
      bumperInterval: 3,
    };
    const prisma = {
      programState: {
        findUnique: jest.fn().mockImplementation(async () => ({
          id: 10,
          radioSettings: settings,
        })),
      },
      radioSettings: {
        upsert: jest
          .fn()
          .mockImplementation(async ({ update }: Update) =>
            Object.assign(settings, update),
          ),
      },
    };
    const metrics = new RadioMetricsService();
    const service = new RadioService(
      prisma as never,
      {} as never,
      {} as never,
      metrics,
      {
        teamId: 0,
      } as never,
    );
    await service.updateRadioSettings('radio', {
      listenerUrl: 'https://radio.example/stream?format=mp3',
    });
    expect(await service.getRadioSettings('radio')).toMatchObject({
      listenerUrl: 'https://radio.example/stream?format=mp3',
      enabled: true,
      bumperInterval: 3,
    });
    await service.updateRadioSettings('radio', { listenerUrl: null });
    expect(settings.listenerUrl).toBeNull();
    await expect(
      service.updateRadioSettings('radio', {
        listenerUrl: 'javascript:alert(1)',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    prisma.radioSettings.upsert.mockRejectedValueOnce(
      new Error('database unavailable'),
    );
    await expect(
      service.updateRadioSettings('radio', {
        listenerUrl: 'https://radio.example/stream',
      }),
    ).rejects.toThrow('database unavailable');
    const rendered = metrics.render();
    expect(rendered).toContain(
      'alcantara_radio_listener_configuration_total{result="success"} 2',
    );
    expect(rendered).toContain(
      'alcantara_radio_listener_configuration_total{result="failure"} 2',
    );
    expect(rendered).not.toContain('radio.example');
  });

  it.each([
    'not-a-url',
    'https://user:password@radio.example/stream',
    'http://radio.example/stream',
    'https://radio.example/stream#fragment',
    12,
  ])(
    'rejects an invalid or credential-bearing listener URL %s before persistence',
    async (listenerUrl) => {
      const prisma = {
        programState: { findUnique: jest.fn().mockResolvedValue({ id: 10 }) },
        radioSettings: { upsert: jest.fn() },
      };
      const service = new RadioService(
        prisma as never,
        {} as never,
        {} as never,
        new RadioMetricsService(),
        { teamId: 0 } as never,
      );
      await expect(
        service.updateRadioSettings('radio', { listenerUrl } as never),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.radioSettings.upsert).not.toHaveBeenCalled();
    },
  );
  it('persists every bumper field exposed by the radio console', async () => {
    const prisma = {
      programState: { findUnique: jest.fn().mockResolvedValue({ id: 10 }) },
      radioSettings: {
        upsert: jest.fn().mockImplementation(({ update }: Update) => update),
      },
    };
    const service = new RadioService(
      prisma as never,
      {} as never,
      {} as never,
      new RadioMetricsService(),
      { teamId: 0 } as never,
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
    };
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
    };
    const service = new RadioService(
      prisma as never,
      palazzo as never,
      {} as never,
      new RadioMetricsService(),
      { teamId: 0 } as never,
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
    };
    const service = new RadioService(
      prisma as never,
      {} as never,
      {} as never,
      new RadioMetricsService(),
      { teamId: 0 } as never,
    );
    await expect(
      service.updateRadioSettings('palazzo', { bumperInterval: 0 }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

// alcantara#875: a show with no radio settings starts from a blank form, and saving it must work.
describe('RadioService settings from a blank form', () => {
  const build = () => {
    const upsert = jest
      .fn<Promise<object>, [Upsert]>()
      .mockImplementation(async ({ create }) => create);
    const prisma = {
      programState: { findUnique: jest.fn().mockResolvedValue({ id: 10 }) },
      radioSettings: { upsert },
    };
    const palazzo = {
      validateBaseUrl: jest.fn((value: string) => {
        if (!value.trim()) throw new BadRequestException('invalid URL');
        return value;
      }),
    };
    const service = new RadioService(
      prisma as never,
      palazzo as never,
      {} as never,
      new RadioMetricsService(),
      { teamId: 0 } as never,
    );
    return { service, upsert, palazzo };
  };
  const blank = {
    palazzoUrl: '',
    bumperEnabled: false,
    bumperInterval: null,
    bumperInstantIds: [],
    bumperMode: null,
    enabled: false,
  };

  it('saves the blank form, with the defaults for what it leaves empty', async () => {
    const { service, upsert, palazzo } = build();

    await expect(
      service.updateRadioSettings('new-show', blank as never),
    ).resolves.toMatchObject({
      palazzoUrl: 'http://palazzo:3100',
      bumperMode: 'sequential',
      bumperInterval: null,
      enabled: false,
    });
    expect(palazzo.validateBaseUrl).not.toHaveBeenCalled();
    expect(upsert.mock.calls[0][0].update).not.toHaveProperty('bumperMode');
    expect(upsert.mock.calls[0][0].update).not.toHaveProperty('palazzoUrl');
  });

  it('reads a null in any optional field as not set', async () => {
    const { service, upsert } = build();

    await service.updateRadioSettings('new-show', {
      palazzoUrl: null,
      bumperEnabled: null,
      bumperInstantIds: null,
      bumperMode: null,
      enabled: null,
      segueMode: null,
      similarityMode: null,
      similarityPool: null,
      similarityThreshold: null,
      similarityWindowSeconds: null,
    } as never);

    expect(upsert.mock.calls[0][0].update).toEqual({});
  });

  it('still refuses a blank engine URL when the save turns radio on, and a wrong value anywhere', async () => {
    const { service, upsert } = build();

    await expect(
      service.updateRadioSettings('new-show', {
        ...blank,
        enabled: true,
      } as never),
    ).rejects.toThrow('invalid URL');
    await expect(
      service.updateRadioSettings('new-show', {
        ...blank,
        bumperMode: 'shuffled',
      } as never),
    ).rejects.toThrow('bumperMode must be sequential or random');
    expect(upsert).not.toHaveBeenCalled();
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
      // No program radio filler configured (gaulatti/alcantara#126).
      fillerLeg: { findUnique: jest.fn().mockResolvedValue(null) },
      song: {
        findMany: jest.fn().mockResolvedValue([
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
          .mockImplementation(async ({ data }: Data) =>
            Object.assign(settings, data),
          ),
      },
    };
    const palazzo = {
      prepareFiller: jest.fn().mockResolvedValue(undefined),
      getAutomation: jest.fn().mockResolvedValue({
        lastSequence: 1,
        requestedState: 'stopped',
        actualState: 'stopped',
        filler: { activeVersion: null, ready: false },
      }),
    };
    const config = {
      get: (key: string) =>
        key === 'MEDIA_S3_BUCKET' ? 'media-test' : 'us-east-1',
    } as never;
    const request = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('fixture audio'));
    try {
      const metrics = new RadioMetricsService();
      const result = await new RadioService(
        prisma as never,
        palazzo as never,
        config,
        metrics,
        {
          teamId: 0,
        } as never,
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
        findUnique: jest.fn().mockResolvedValue({
          radioSettings: { id: 9, palazzoUrl: 'http://palazzo:3100' },
        }),
      },
      fillerLeg: { findUnique: jest.fn().mockResolvedValue(null) },
      song: {
        findMany: jest
          .fn()
          .mockResolvedValue([
            { id: 5, enabled: true, audioUrl: 'http://internal.test/audio' },
          ]),
      },
    };
    const palazzo = { prepareFiller: jest.fn() };
    const request = jest.spyOn(globalThis, 'fetch');
    try {
      const metrics = new RadioMetricsService();
      await expect(
        new RadioService(
          prisma as never,
          palazzo as never,
          { get: () => 'media-test' } as never,
          metrics,
          { teamId: 0 } as never,
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

  it('rejects reads and updates for a program that does not exist', async () => {
    const prisma = {
      programState: { findUnique: jest.fn().mockResolvedValue(null) },
      radioSettings: { upsert: jest.fn() },
    };
    const service = new RadioService(
      prisma as never,
      {} as never,
      {} as never,
      new RadioMetricsService(),
      { teamId: 0 } as never,
    );
    await expect(service.getRadioSettings('missing')).rejects.toThrow(
      'Program not found',
    );
    await expect(
      service.updateRadioSettings('missing', { enabled: true }),
    ).rejects.toThrow('Program not found');
    expect(prisma.radioSettings.upsert).not.toHaveBeenCalled();
  });

  it('refuses Palazzo commands when stored settings carry no Palazzo URL', async () => {
    const prisma = {
      programState: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ id: 10, radioSettings: { id: 9 } }),
      },
    };
    const palazzo = { getPlaybackState: jest.fn() };
    const service = new RadioService(
      prisma as never,
      palazzo as never,
      {} as never,
      new RadioMetricsService(),
      { teamId: 0 } as never,
    );
    await expect(service.getPlaybackState('radio')).rejects.toThrow(
      'playback state is unavailable',
    );
    expect(palazzo.getPlaybackState).not.toHaveBeenCalled();
  });
});
