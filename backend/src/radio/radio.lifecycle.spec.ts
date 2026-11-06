import {
  BadGatewayException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ReadableStream } from 'node:stream/web';
import { RadioService } from './radio.service';
import { PalazzoMachineError } from './palazzo-machine.client';

function fixture(configuration: Record<string, unknown> = {}) {
  const settings: any = {
    id: 9,
    palazzoUrl: 'https://radio.example',
    enabled: true,
    fillerSongIds: [5],
    fillerVersion: 'filler-ready',
  };
  const prisma = {
    programState: {
      findUnique: jest.fn(async () => ({ id: 7, radioSettings: settings })),
    },
    radioSettings: {
      update: jest.fn(async ({ data }: any) => Object.assign(settings, data)),
      upsert: jest.fn(async ({ update }: any) =>
        Object.assign(settings, update),
      ),
    },
    song: {
      findMany: jest.fn().mockResolvedValue([
        {
          id: 5,
          enabled: true,
          audioUrl: 'https://media-test.s3.amazonaws.com/song.mp3',
        },
      ]),
    },
  };
  const palazzo = {
    validateBaseUrl: jest.fn((url: string) => url.trim()),
    prepareFiller: jest.fn().mockResolvedValue(undefined),
    getAutomation: jest.fn().mockResolvedValue({
      lastSequence: 8,
      requestedState: 'stopped',
      actualState: 'stopped',
    }),
    commandAutomation: jest.fn().mockResolvedValue(undefined),
    playSong: jest.fn().mockResolvedValue({
      playbackRequestId: 'accepted-request',
      introPlaybackId: null,
    }),
    stopSong: jest.fn().mockResolvedValue(undefined),
    playInstant: jest.fn().mockResolvedValue(undefined),
    updateMixer: jest.fn().mockResolvedValue(undefined),
    stopInstants: jest.fn().mockResolvedValue(undefined),
    getPlaybackState: jest.fn().mockResolvedValue({
      liquidsoap: { running: true, connected: true },
      icecast: { connected: true },
    }),
  };
  const metrics = {
    recordRecoveryPreparation: jest.fn(),
    recordListenerConfiguration: jest.fn(),
  };
  const config = new ConfigService({
    MEDIA_S3_BUCKET: 'media-test',
    AWS_REGION: 'us-east-1',
    ...configuration,
  });
  return {
    service: new RadioService(
      prisma as any,
      palazzo as any,
      config,
      metrics as any,
    ),
    settings,
    prisma,
    palazzo,
    metrics,
  };
}
const mixer = {
  mainVolume: 1,
  songVolume: 1,
  instantVolume: 1,
  songMuted: false,
  instantMuted: false,
};

describe('RadioService recovery and unavailable executor boundaries', () => {
  let fetchMock: jest.SpyInstance;
  beforeEach(() => {
    fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => new Response('native audio fixture'));
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('reports a disconnected recovery endpoint without misreporting prepared playlist configuration', async () => {
    const f = fixture();
    f.palazzo.getAutomation.mockRejectedValue(new Error('unavailable'));
    expect(await f.service.getRecoveryStatus('news')).toEqual({
      selectedSongIds: [5],
      preparedVersion: 'filler-ready',
      automation: null,
      connection: 'unavailable',
    });
  });

  it.each(
    [
      undefined,
      [],
      [5, 5],
      [0],
      [1.5],
      ['5'],
      Array.from({ length: 101 }, (_, index) => index + 1),
    ].map((value) => [value] as const),
  )(
    'rejects an invalid recovery catalog selection before downloading: %p',
    async (ids) => {
      const f = fixture();
      await expect(
        f.service.prepareRecoveryPlaylist('news', ids as any),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(f.palazzo.prepareFiller).not.toHaveBeenCalled();
      expect(f.metrics.recordRecoveryPreparation).toHaveBeenCalledWith(
        'failed',
      );
    },
  );

  it.each(
    [
      [],
      [
        {
          id: 5,
          enabled: false,
          audioUrl: 'https://media-test.s3.amazonaws.com/song.mp3',
        },
      ],
      [{ id: 5, enabled: true, audioUrl: ' ' }],
    ].map((value) => [value] as const),
  )(
    'requires every recovery song to be enabled and playable: %p',
    async (songs) => {
      const f = fixture();
      f.prisma.song.findMany.mockResolvedValue(songs);
      await expect(
        f.service.prepareRecoveryPlaylist('news', [5]),
      ).rejects.toThrow('enabled and have audio');
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it('requires an accepted managed bucket before downloading any recovery media', async () => {
    const f = fixture({ MEDIA_S3_BUCKET: undefined });
    await expect(
      f.service.prepareRecoveryPlaylist('news', [5]),
    ).rejects.toThrow('managed media bucket is unavailable');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    'not a URL',
    'http://media-test.s3.amazonaws.com/song.mp3',
    'https://other.s3.amazonaws.com/song.mp3',
    'https://user@media-test.s3.amazonaws.com/song.mp3',
    'https://:secret@media-test.s3.amazonaws.com/song.mp3',
    'https://media-test.s3.amazonaws.com:8443/song.mp3',
  ])(
    'rejects a malformed or non-managed download URL without making the request: %s',
    async (audioUrl) => {
      const f = fixture();
      f.prisma.song.findMany.mockResolvedValue([
        { id: 5, enabled: true, audioUrl },
      ]);
      await expect(
        f.service.prepareRecoveryPlaylist('news', [5]),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it.each(['network', 'http', 'missing-body', 'empty', 'read-error'])(
    'preserves failure of %s media validation without publishing a ready recovery version',
    async (failure) => {
      const f = fixture();
      if (failure === 'network')
        fetchMock.mockRejectedValueOnce(new Error('network unavailable'));
      if (failure === 'http')
        fetchMock.mockResolvedValueOnce(
          new Response('unavailable', { status: 502 }),
        );
      if (failure === 'missing-body')
        fetchMock.mockResolvedValueOnce(new Response(null));
      if (failure === 'empty')
        fetchMock.mockResolvedValueOnce(new Response(''));
      if (failure === 'read-error')
        fetchMock.mockResolvedValueOnce(
          new Response(
            new ReadableStream({
              start(controller) {
                controller.error(new Error('read interrupted'));
              },
            }) as any,
          ),
        );
      await expect(
        f.service.prepareRecoveryPlaylist('news', [5]),
      ).rejects.toBeInstanceOf(
        failure === 'read-error' ? BadGatewayException : BadRequestException,
      );
      expect(f.palazzo.prepareFiller).not.toHaveBeenCalled();
      expect(f.prisma.radioSettings.update).not.toHaveBeenCalled();
      expect(f.metrics.recordRecoveryPreparation).toHaveBeenLastCalledWith(
        'failed',
      );
    },
  );

  it('enforces the512MiB real streamed-audio limit without allocating the entire response at once', async () => {
    const f = fixture();
    const chunk = new Uint8Array(1024 * 1024);
    let count = 0;
    fetchMock.mockResolvedValueOnce(
      new Response(
        new ReadableStream({
          pull(controller) {
            if (count++ < 513) controller.enqueue(chunk);
            else controller.close();
          },
        }) as any,
      ),
    );
    await expect(
      f.service.prepareRecoveryPlaylist('news', [5]),
    ).rejects.toThrow('exceeds 512 MiB');
    expect(f.palazzo.prepareFiller).not.toHaveBeenCalled();
    expect(f.prisma.radioSettings.update).not.toHaveBeenCalled();
  });

  it('accepts the configured regional bucket endpoint but does not publish readiness before downstream preparation succeeds', async () => {
    const f = fixture();
    f.prisma.song.findMany.mockResolvedValue([
      {
        id: 5,
        enabled: true,
        audioUrl: 'https://media-test.s3.us-east-1.amazonaws.com/song.mp3',
      },
    ]);
    f.palazzo.prepareFiller.mockRejectedValueOnce(new Error('prepare failed'));
    await expect(
      f.service.prepareRecoveryPlaylist('news', [5]),
    ).rejects.toThrow('could not prepare');
    expect(f.prisma.radioSettings.update).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith(
      'https://media-test.s3.us-east-1.amazonaws.com/song.mp3',
      expect.objectContaining({
        redirect: 'error',
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it('requires preparation for recovery start and advances the exact downstream command sequence for start and stop', async () => {
    const f = fixture();
    f.settings.fillerVersion = null;
    await expect(
      f.service.setRecoveryAutomation('news', 'start'),
    ).rejects.toThrow('prepare a recovery playlist first');
    f.settings.fillerVersion = 'filler-ready';
    expect(
      (await f.service.setRecoveryAutomation('news', 'start')).connection,
    ).toBe('connected');
    expect(f.palazzo.commandAutomation).toHaveBeenLastCalledWith(
      'https://radio.example',
      'news',
      'start',
      9,
      expect.any(String),
      'filler-ready',
    );
    f.settings.fillerVersion = null;
    await f.service.setRecoveryAutomation('news', 'stop');
    expect(f.palazzo.commandAutomation).toHaveBeenLastCalledWith(
      'https://radio.example',
      'news',
      'stop',
      9,
      expect.any(String),
      undefined,
    );
  });

  it('does not send recovery commands when status is unavailable and preserves rejected command outcomes', async () => {
    const f = fixture();
    f.palazzo.getAutomation.mockRejectedValueOnce(
      new Error('status unavailable'),
    );
    await expect(
      f.service.setRecoveryAutomation('news', 'start'),
    ).rejects.toThrow('recovery status is unavailable');
    expect(f.palazzo.commandAutomation).not.toHaveBeenCalled();
    f.palazzo.commandAutomation.mockRejectedValueOnce(
      new Error('command unavailable'),
    );
    await expect(
      f.service.setRecoveryAutomation('news', 'stop'),
    ).rejects.toThrow('could not stop');
  });

  it('returns explicit failed playSong outcomes with generated or supplied request identity', async () => {
    const f = fixture();
    f.prisma.programState.findUnique.mockResolvedValueOnce({
      id: 7,
      radioSettings: null,
    } as any);
    expect(
      await f.service.playSong('news', 'https://media.test/song.mp3'),
    ).toEqual({ ok: false });
    f.palazzo.playSong.mockRejectedValueOnce(
      new PalazzoMachineError('unavailable'),
    );
    expect(
      await f.service.playSong(
        'news',
        'https://media.test/song.mp3',
        undefined,
        undefined,
        ' supplied-request ',
      ),
    ).toEqual({ ok: false, playbackRequestId: 'supplied-request' });
    f.palazzo.playSong.mockRejectedValueOnce(
      new Error('private transport detail'),
    );
    expect(
      await f.service.playSong('news', 'https://media.test/song.mp3'),
    ).toMatchObject({
      ok: false,
      playbackRequestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
  });

  it.each([
    'stopSong',
    'playInstant',
    'updateMixer',
    'getPlaybackState',
    'stopAllInstants',
  ] as const)(
    'fails %s visibly when the executor rejects the operation',
    async (operation) => {
      const f = fixture();
      const method =
        operation === 'stopAllInstants' ? 'stopInstants' : operation;
      f.palazzo[method].mockRejectedValueOnce(new Error('unavailable'));
      const result =
        operation === 'playInstant'
          ? f.service.playInstant('news', 'https://media.test/clip.mp3')
          : operation === 'updateMixer'
            ? f.service.updateMixer('news', mixer)
            : f.service[operation]('news');
      await expect(result).rejects.toBeInstanceOf(BadGatewayException);
      expect(Logger.prototype.error).toHaveBeenCalledWith(
        expect.objectContaining({ operation, reason: 'unavailable' }),
      );
    },
  );

  it('requires actual settings and a nonempty upstream base URL instead of sending unauthenticated arbitrary requests', async () => {
    const f = fixture();
    f.prisma.programState.findUnique.mockResolvedValueOnce({
      id: 7,
      radioSettings: null,
    } as any);
    await expect(f.service.stopSong('news')).rejects.toThrow(
      'Radio settings are unavailable',
    );
    f.settings.palazzoUrl = ' ';
    await expect(f.service.getPlaybackState('news')).rejects.toThrow(
      'playback state is unavailable',
    );
    expect(f.palazzo.getPlaybackState).not.toHaveBeenCalled();
  });

  it.each([
    {
      liquidsoap: { running: false, connected: true },
      icecast: { connected: true },
    },
    {
      liquidsoap: { running: true, connected: false },
      icecast: { connected: true },
    },
    {
      liquidsoap: { running: true, connected: true },
      icecast: { connected: false },
    },
  ])(
    'does not report running unless every real playout connection is healthy: %p',
    async (state) => {
      const f = fixture();
      f.palazzo.getPlaybackState.mockResolvedValue(state);
      expect(await f.service.getPalazzoStatus('news')).toEqual({
        running: false,
        uptime: null,
      });
    },
  );

  it.each([
    { bumperInstantIds: 'invalid' },
    { bumperInstantIds: [0] },
    { bumperInstantIds: [1.5] },
    { bumperMode: 'randomish' },
  ])(
    'rejects invalid bumper settings before persistence: %p',
    async (settings) => {
      const f = fixture();
      await expect(
        f.service.updateRadioSettings('news', settings as any),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(f.prisma.radioSettings.upsert).not.toHaveBeenCalled();
    },
  );

  it('clears empty listener settings and explicitly preserves false, null and empty bumper controls', async () => {
    const f = fixture();
    expect(
      await f.service.updateRadioSettings('news', {
        listenerUrl: '   ',
        palazzoUrl: ' https://radio.example ',
        bumperEnabled: false,
        bumperInterval: null,
        bumperInstantIds: [],
        bumperMode: 'sequential',
        enabled: false,
      }),
    ).toMatchObject({
      listenerUrl: null,
      palazzoUrl: 'https://radio.example',
      bumperEnabled: false,
      bumperInterval: null,
      bumperInstantIds: [],
      bumperMode: 'sequential',
      enabled: false,
    });
    expect(f.palazzo.validateBaseUrl).toHaveBeenCalledWith(
      ' https://radio.example ',
    );
  });
});
