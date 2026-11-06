import { BadGatewayException, BadRequestException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { RadioService } from './radio.service';
import { PalazzoMachineError } from './palazzo-machine.client';

const BUCKET = 'media-bucket';
const AUDIO_URL = `https://${BUCKET}.s3.amazonaws.com/a.mp3`;

function build(settings: Record<string, unknown> | null = defaultSettings()) {
  const prisma: any = {
    programState: {
      findUnique: jest
        .fn()
        .mockResolvedValue(
          settings === undefined ? null : { id: 10, radioSettings: settings },
        ),
    },
    radioSettings: {
      upsert: jest.fn().mockImplementation(async (arg) => arg),
      update: jest.fn().mockResolvedValue({}),
    },
    song: { findMany: jest.fn().mockResolvedValue([]) },
  };
  const palazzo: any = {
    getAutomation: jest.fn().mockResolvedValue({ lastSequence: 4 }),
    commandAutomation: jest.fn().mockResolvedValue(undefined),
    prepareFiller: jest.fn().mockResolvedValue(undefined),
    validateBaseUrl: jest.fn((v: string) => `valid:${v}`),
    playSong: jest.fn(),
    stopSong: jest.fn().mockResolvedValue(undefined),
    playInstant: jest.fn().mockResolvedValue(undefined),
    updateMixer: jest.fn().mockResolvedValue(undefined),
    getPlaybackState: jest.fn(),
    stopInstants: jest.fn().mockResolvedValue(undefined),
  };
  const configValues: Record<string, string | undefined> = {
    MEDIA_S3_BUCKET: BUCKET,
    AWS_REGION: 'us-east-1',
  };
  const config: any = { get: jest.fn((key: string) => configValues[key]) };
  const metrics: any = {
    recordRecoveryPreparation: jest.fn(),
    recordListenerConfiguration: jest.fn(),
  };
  const service = new RadioService(prisma, palazzo, config, metrics);
  jest.spyOn(service['logger'], 'error').mockImplementation();
  return { service, prisma, palazzo, config, configValues, metrics };
}

function defaultSettings(): Record<string, unknown> {
  return {
    id: 99,
    palazzoUrl: ' http://palazzo:3100 ',
    fillerSongIds: [1],
    fillerVersion: 'filler-v1',
  };
}

function streamResponse(chunks: Uint8Array[]) {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    }),
  );
}

describe('RadioService coverage', () => {
  afterEach(() => jest.restoreAllMocks());

  describe('getRadioSettings', () => {
    it('throws when the program does not exist', async () => {
      const { service, prisma } = build();
      prisma.programState.findUnique.mockResolvedValue(null);
      await expect(service.getRadioSettings('x')).rejects.toThrow(
        'Program not found',
      );
    });

    it('returns null when the program has no radio settings', async () => {
      const { service, prisma } = build();
      prisma.programState.findUnique.mockResolvedValue({
        id: 1,
        radioSettings: null,
      });
      await expect(service.getRadioSettings('x')).resolves.toBeNull();
      expect(prisma.programState.findUnique).toHaveBeenCalledWith({
        where: { programId: 'x' },
        include: { radioSettings: true },
      });
    });
  });

  describe('getRecoveryStatus', () => {
    it('reports connected automation', async () => {
      const { service, palazzo } = build();
      await expect(service.getRecoveryStatus('p')).resolves.toEqual({
        selectedSongIds: [1],
        preparedVersion: 'filler-v1',
        automation: { lastSequence: 4 },
        connection: 'connected',
      });
      expect(palazzo.getAutomation).toHaveBeenCalledWith(
        'http://palazzo:3100',
        'p',
      );
    });

    it('reports unavailable when palazzo cannot be reached', async () => {
      const { service, palazzo } = build();
      palazzo.getAutomation.mockRejectedValue(new Error('down'));
      await expect(service.getRecoveryStatus('p')).resolves.toEqual({
        selectedSongIds: [1],
        preparedVersion: 'filler-v1',
        automation: null,
        connection: 'unavailable',
      });
    });

    it('fails when radio settings are missing', async () => {
      const { service, prisma } = build();
      prisma.programState.findUnique.mockResolvedValue({
        id: 1,
        radioSettings: null,
      });
      await expect(service.getRecoveryStatus('p')).rejects.toThrow(
        new BadGatewayException('Radio settings are unavailable'),
      );
    });
  });

  describe('prepareRecoveryPlaylist validation', () => {
    const invalid: Array<[string, unknown]> = [
      ['a non-array', 'nope'],
      ['an empty list', []],
      ['more than 100 songs', Array.from({ length: 101 }, (_, i) => i + 1)],
      ['duplicates', [1, 1]],
      ['non-integers', [1.5]],
      ['ids below one', [0]],
    ];
    it.each(invalid)('rejects %s and records a failure', async (_n, ids) => {
      const { service, metrics, prisma } = build();
      await expect(
        service.prepareRecoveryPlaylist('p', ids as number[]),
      ).rejects.toThrow(
        new BadRequestException('select 1 to 100 distinct catalog songs'),
      );
      expect(metrics.recordRecoveryPreparation).toHaveBeenCalledWith('failed');
      expect(prisma.song.findMany).not.toHaveBeenCalled();
    });

    it('accepts exactly 100 distinct songs past validation', async () => {
      const { service, prisma } = build();
      const ids = Array.from({ length: 100 }, (_, i) => i + 1);
      await expect(service.prepareRecoveryPlaylist('p', ids)).rejects.toThrow(
        'every recovery song must be enabled and have audio',
      );
      expect(prisma.song.findMany).toHaveBeenCalledWith({
        where: { id: { in: ids } },
        select: { id: true, enabled: true, audioUrl: true },
      });
    });

    it('rejects when a requested song does not exist', async () => {
      const { service } = build();
      await expect(service.prepareRecoveryPlaylist('p', [1])).rejects.toThrow(
        'every recovery song must be enabled and have audio',
      );
    });

    it('rejects disabled songs', async () => {
      const { service, prisma } = build();
      prisma.song.findMany.mockResolvedValue([
        { id: 1, enabled: false, audioUrl: AUDIO_URL },
      ]);
      await expect(service.prepareRecoveryPlaylist('p', [1])).rejects.toThrow(
        'every recovery song must be enabled and have audio',
      );
    });

    it('rejects songs with blank audio', async () => {
      const { service, prisma } = build();
      prisma.song.findMany.mockResolvedValue([
        { id: 1, enabled: true, audioUrl: '   ' },
      ]);
      await expect(service.prepareRecoveryPlaylist('p', [1])).rejects.toThrow(
        'every recovery song must be enabled and have audio',
      );
    });

    it('rejects when the managed bucket is not configured', async () => {
      const { service, prisma, configValues } = build();
      configValues.MEDIA_S3_BUCKET = '  ';
      prisma.song.findMany.mockResolvedValue([
        { id: 1, enabled: true, audioUrl: AUDIO_URL },
      ]);
      await expect(service.prepareRecoveryPlaylist('p', [1])).rejects.toThrow(
        'managed media bucket is unavailable',
      );
    });

    it('rejects when the bucket setting is absent entirely', async () => {
      const { service, prisma, configValues } = build();
      delete configValues.MEDIA_S3_BUCKET;
      prisma.song.findMany.mockResolvedValue([
        { id: 1, enabled: true, audioUrl: AUDIO_URL },
      ]);
      await expect(service.prepareRecoveryPlaylist('p', [1])).rejects.toThrow(
        'managed media bucket is unavailable',
      );
    });

    it('rejects when radio settings are missing', async () => {
      const { service, prisma } = build();
      prisma.programState.findUnique.mockResolvedValue({
        id: 1,
        radioSettings: null,
      });
      await expect(service.prepareRecoveryPlaylist('p', [1])).rejects.toThrow(
        'Radio settings are unavailable',
      );
    });
  });

  describe('prepareRecoveryPlaylist audio sources', () => {
    const withSong = (audioUrl: string) => {
      const ctx = build();
      ctx.prisma.song.findMany.mockResolvedValue([
        { id: 1, enabled: true, audioUrl },
      ]);
      return ctx;
    };

    it('rejects an unparsable URL', async () => {
      const { service } = withSong('not a url');
      await expect(service.prepareRecoveryPlaylist('p', [1])).rejects.toThrow(
        'recovery song has an invalid URL',
      );
    });

    it.each([
      ['plain http', `http://${BUCKET}.s3.amazonaws.com/a.mp3`],
      ['a foreign host', 'https://evil.example.com/a.mp3'],
      ['embedded username', `https://u@${BUCKET}.s3.amazonaws.com/a.mp3`],
      ['embedded password', `https://:p@${BUCKET}.s3.amazonaws.com/a.mp3`],
      ['an explicit port', `https://${BUCKET}.s3.amazonaws.com:8443/a.mp3`],
    ])('rejects %s', async (_n, url) => {
      const { service } = withSong(url);
      const fetchSpy = jest.spyOn(global, 'fetch');
      await expect(service.prepareRecoveryPlaylist('p', [1])).rejects.toThrow(
        'recovery audio must use the managed media bucket',
      );
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('reports unreadable audio when the fetch fails', async () => {
      const { service } = withSong(AUDIO_URL);
      jest.spyOn(global, 'fetch').mockRejectedValue(new Error('net'));
      await expect(service.prepareRecoveryPlaylist('p', [1])).rejects.toThrow(
        new BadRequestException('recovery audio could not be read'),
      );
    });

    it('reports unreadable audio on a non-ok response', async () => {
      const { service } = withSong(AUDIO_URL);
      jest
        .spyOn(global, 'fetch')
        .mockResolvedValue(new Response('x', { status: 404 }));
      await expect(service.prepareRecoveryPlaylist('p', [1])).rejects.toThrow(
        new BadRequestException('recovery audio could not be read'),
      );
    });

    it('reports unreadable audio when the response has no body', async () => {
      const { service } = withSong(AUDIO_URL);
      jest
        .spyOn(global, 'fetch')
        .mockResolvedValue(new Response(null, { status: 200 }));
      await expect(service.prepareRecoveryPlaylist('p', [1])).rejects.toThrow(
        new BadRequestException('recovery audio could not be read'),
      );
    });

    it('maps a mid-stream read error to bad gateway', async () => {
      const { service } = withSong(AUDIO_URL);
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.error(new Error('reset'));
        },
      });
      jest.spyOn(global, 'fetch').mockResolvedValue(new Response(body));
      await expect(service.prepareRecoveryPlaylist('p', [1])).rejects.toThrow(
        new BadGatewayException('recovery audio could not be read'),
      );
    });

    it('rejects audio larger than 512 MiB and cancels the body', async () => {
      const { service } = withSong(AUDIO_URL);
      const cancel = jest.fn().mockRejectedValue(new Error('cancel failed'));
      const body = {
        async *[Symbol.asyncIterator]() {
          yield { byteLength: 512 * 1024 * 1024 + 1 };
        },
        cancel,
      };
      jest
        .spyOn(global, 'fetch')
        .mockResolvedValue({ ok: true, body } as unknown as Response);
      await expect(service.prepareRecoveryPlaylist('p', [1])).rejects.toThrow(
        new BadRequestException('recovery audio exceeds 512 MiB'),
      );
      expect(cancel).toHaveBeenCalled();
    });

    it('rejects empty audio', async () => {
      const { service } = withSong(AUDIO_URL);
      jest.spyOn(global, 'fetch').mockResolvedValue(streamResponse([]));
      await expect(service.prepareRecoveryPlaylist('p', [1])).rejects.toThrow(
        new BadRequestException('recovery audio is empty'),
      );
    });
  });

  describe('prepareRecoveryPlaylist handoff', () => {
    const regionalUrl = `https://${BUCKET}.s3.us-east-1.amazonaws.com/b.mp3`;
    const setup = () => {
      const ctx = build();
      ctx.prisma.song.findMany.mockResolvedValue([
        { id: 1, enabled: true, audioUrl: AUDIO_URL },
        { id: 2, enabled: true, audioUrl: regionalUrl },
      ]);
      return ctx;
    };

    it('hashes both bucket host styles, prepares palazzo and persists the version', async () => {
      const { service, prisma, palazzo, metrics } = setup();
      const bodies: Record<string, Uint8Array[]> = {
        [AUDIO_URL]: [new Uint8Array([1, 2]), new Uint8Array([3])],
        [regionalUrl]: [new Uint8Array([9])],
      };
      const fetchSpy = jest
        .spyOn(global, 'fetch')
        .mockImplementation(async (url) => streamResponse(bodies[String(url)]));
      const result = await service.prepareRecoveryPlaylist('p', [2, 1]);

      const [url, init] = fetchSpy.mock.calls[0];
      expect(url).toBe(regionalUrl);
      expect(init?.redirect).toBe('error');
      const [, , version, assets] = palazzo.prepareFiller.mock.calls[0];
      expect(version).toMatch(/^filler-[0-9a-f-]{36}$/);
      expect(assets).toEqual([
        {
          id: 'song-2',
          sha256: createHash('sha256')
            .update(Buffer.from([9]))
            .digest('hex'),
          downloadUrl: regionalUrl,
        },
        {
          id: 'song-1',
          sha256: createHash('sha256')
            .update(Buffer.from([1, 2, 3]))
            .digest('hex'),
          downloadUrl: AUDIO_URL,
        },
      ]);
      expect(palazzo.prepareFiller).toHaveBeenCalledWith(
        'http://palazzo:3100',
        'p',
        version,
        assets,
      );
      expect(prisma.radioSettings.update).toHaveBeenCalledWith({
        where: { id: 99 },
        data: { fillerSongIds: [2, 1], fillerVersion: version },
      });
      expect(result).toMatchObject({ connection: 'connected' });
      expect(metrics.recordRecoveryPreparation).toHaveBeenCalledWith('ready');
    });

    it('maps palazzo preparation failures to bad gateway without persisting', async () => {
      const { service, prisma, palazzo, metrics } = setup();
      jest
        .spyOn(global, 'fetch')
        .mockImplementation(async () => streamResponse([new Uint8Array([1])]));
      palazzo.prepareFiller.mockRejectedValue(new Error('refused'));
      await expect(
        service.prepareRecoveryPlaylist('p', [1, 2]),
      ).rejects.toThrow(
        new BadGatewayException(
          'Palazzo could not prepare the recovery playlist',
        ),
      );
      expect(prisma.radioSettings.update).not.toHaveBeenCalled();
      expect(metrics.recordRecoveryPreparation).toHaveBeenCalledWith('failed');
    });
  });

  describe('setRecoveryAutomation', () => {
    it('refuses to start without a prepared playlist', async () => {
      const { service, prisma, palazzo } = build();
      prisma.programState.findUnique.mockResolvedValue({
        id: 1,
        radioSettings: { ...defaultSettings(), fillerVersion: null },
      });
      await expect(service.setRecoveryAutomation('p', 'start')).rejects.toThrow(
        new BadRequestException('prepare a recovery playlist first'),
      );
      expect(palazzo.getAutomation).not.toHaveBeenCalled();
    });

    it('fails when the current automation status cannot be read', async () => {
      const { service, palazzo } = build();
      palazzo.getAutomation.mockRejectedValue(new Error('down'));
      await expect(service.setRecoveryAutomation('p', 'stop')).rejects.toThrow(
        new BadGatewayException('Palazzo recovery status is unavailable'),
      );
    });

    it('starts with the prepared version and the next sequence', async () => {
      const { service, palazzo } = build();
      await service.setRecoveryAutomation('p', 'start');
      expect(palazzo.commandAutomation).toHaveBeenCalledWith(
        'http://palazzo:3100',
        'p',
        'start',
        5,
        expect.stringMatching(/^[0-9a-f-]{36}$/),
        'filler-v1',
      );
    });

    it('stops without a version, even if no playlist was prepared', async () => {
      const { service, prisma, palazzo } = build();
      prisma.programState.findUnique.mockResolvedValue({
        id: 1,
        radioSettings: { ...defaultSettings(), fillerVersion: null },
      });
      await expect(
        service.setRecoveryAutomation('p', 'stop'),
      ).resolves.toMatchObject({ connection: 'connected' });
      expect(palazzo.commandAutomation.mock.calls[0][5]).toBeUndefined();
    });

    it('maps command failures to bad gateway naming the action', async () => {
      const { service, palazzo } = build();
      palazzo.commandAutomation.mockRejectedValue(new Error('no'));
      await expect(service.setRecoveryAutomation('p', 'stop')).rejects.toThrow(
        new BadGatewayException('Palazzo could not stop the recovery session'),
      );
    });
  });

  describe('updateRadioSettings', () => {
    it('creates settings with defaults when nothing is supplied', async () => {
      const { service, prisma, metrics } = build();
      await service.updateRadioSettings('p', {});
      expect(prisma.radioSettings.upsert).toHaveBeenCalledWith({
        where: { programStateId: 10 },
        update: {},
        create: {
          programStateId: 10,
          palazzoUrl: 'http://palazzo:3100',
          listenerUrl: null,
          bumperEnabled: false,
          bumperInterval: null,
          bumperInstantIds: [],
          bumperMode: 'sequential',
          enabled: false,
        },
      });
      expect(metrics.recordListenerConfiguration).not.toHaveBeenCalled();
    });

    it('applies every supplied field to update and create and records success', async () => {
      const { service, prisma, palazzo, metrics } = build();
      await service.updateRadioSettings('p', {
        palazzoUrl: 'http://new',
        listenerUrl: '  https://stream.example.com/live  ',
        bumperEnabled: true,
        bumperInterval: 4,
        bumperInstantIds: [3, 3, 5],
        bumperMode: 'random',
        enabled: true,
      });
      expect(palazzo.validateBaseUrl).toHaveBeenCalledWith('http://new');
      const arg = prisma.radioSettings.upsert.mock.calls[0][0];
      expect(arg.update).toEqual({
        palazzoUrl: 'valid:http://new',
        listenerUrl: 'https://stream.example.com/live',
        bumperEnabled: true,
        bumperInterval: 4,
        bumperInstantIds: [3, 5],
        bumperMode: 'random',
        enabled: true,
      });
      expect(arg.create).toEqual({
        programStateId: 10,
        palazzoUrl: 'valid:http://new',
        listenerUrl: 'https://stream.example.com/live',
        bumperEnabled: true,
        bumperInterval: 4,
        bumperInstantIds: [3, 5],
        bumperMode: 'random',
        enabled: true,
      });
      expect(metrics.recordListenerConfiguration).toHaveBeenCalledWith(
        'success',
      );
    });

    it('clears nullable values', async () => {
      const { service, prisma } = build();
      await service.updateRadioSettings('p', {
        listenerUrl: null,
        bumperInterval: null,
      });
      expect(prisma.radioSettings.upsert.mock.calls[0][0].update).toEqual({
        listenerUrl: null,
        bumperInterval: null,
      });
    });

    it('treats a blank listener url as cleared', async () => {
      const { service, prisma } = build();
      await service.updateRadioSettings('p', { listenerUrl: '  ' });
      expect(prisma.radioSettings.upsert.mock.calls[0][0].update).toEqual({
        listenerUrl: null,
      });
    });

    it('fails when the program does not exist, recording a failure only for listener updates', async () => {
      const { service, prisma, metrics } = build();
      prisma.programState.findUnique.mockResolvedValue(null);
      await expect(service.updateRadioSettings('p', {})).rejects.toThrow(
        'Program not found',
      );
      expect(metrics.recordListenerConfiguration).not.toHaveBeenCalled();
      await expect(
        service.updateRadioSettings('p', { listenerUrl: null }),
      ).rejects.toThrow('Program not found');
      expect(metrics.recordListenerConfiguration).toHaveBeenCalledWith(
        'failure',
      );
    });

    it('propagates palazzo url validation failures', async () => {
      const { service, palazzo } = build();
      palazzo.validateBaseUrl.mockImplementation(() => {
        throw new PalazzoMachineError('rejected');
      });
      await expect(
        service.updateRadioSettings('p', { palazzoUrl: 'http://evil' }),
      ).rejects.toBeInstanceOf(PalazzoMachineError);
    });

    describe('normalization errors', () => {
      const cases: Array<[string, any, string]> = [
        [
          'non-string listenerUrl',
          { listenerUrl: 5 },
          'listenerUrl must be a public HTTPS stream URL or null',
        ],
        [
          'unparsable listenerUrl',
          { listenerUrl: 'nope' },
          'listenerUrl must be a public HTTPS stream URL',
        ],
        [
          'http non-local listenerUrl',
          { listenerUrl: 'http://example.com/s' },
          'listenerUrl must use HTTPS without credentials or a fragment',
        ],
        [
          'listenerUrl username',
          { listenerUrl: 'https://u@example.com/s' },
          'listenerUrl must use HTTPS without credentials or a fragment',
        ],
        [
          'listenerUrl password',
          { listenerUrl: 'https://:p@example.com/s' },
          'listenerUrl must use HTTPS without credentials or a fragment',
        ],
        [
          'listenerUrl fragment',
          { listenerUrl: 'https://example.com/s#x' },
          'listenerUrl must use HTTPS without credentials or a fragment',
        ],
        [
          'zero bumperInterval',
          { bumperInterval: 0 },
          'bumperInterval must be a positive integer or null',
        ],
        [
          'fractional bumperInterval',
          { bumperInterval: 1.5 },
          'bumperInterval must be a positive integer or null',
        ],
        [
          'non-array bumperInstantIds',
          { bumperInstantIds: 'x' },
          'bumperInstantIds must contain positive integer IDs',
        ],
        [
          'non-positive bumperInstantIds',
          { bumperInstantIds: [1, 0] },
          'bumperInstantIds must contain positive integer IDs',
        ],
        [
          'fractional bumperInstantIds',
          { bumperInstantIds: [1.2] },
          'bumperInstantIds must contain positive integer IDs',
        ],
        [
          'unknown bumperMode',
          { bumperMode: 'shuffle' },
          'bumperMode must be sequential or random',
        ],
      ];
      it.each(cases)('rejects %s', async (_n, payload, message) => {
        const { service, prisma } = build();
        await expect(service.updateRadioSettings('p', payload)).rejects.toThrow(
          new BadRequestException(message),
        );
        expect(prisma.radioSettings.upsert).not.toHaveBeenCalled();
      });
    });

    it('accepts loopback http listener urls outside production', async () => {
      const previous = process.env.NODE_ENV;
      process.env.NODE_ENV = 'development';
      try {
        const { service, prisma } = build();
        await service.updateRadioSettings('p', {
          listenerUrl: 'http://127.0.0.1:8000/live',
        });
        expect(prisma.radioSettings.upsert.mock.calls[0][0].update).toEqual({
          listenerUrl: 'http://127.0.0.1:8000/live',
        });
      } finally {
        if (previous === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = previous;
      }
    });
  });

  describe('palazzoUrl', () => {
    it.each([
      ['null settings', null],
      ['a non-object', 'text'],
      ['settings without a url', {}],
      ['a non-string url', { palazzoUrl: 5 }],
      ['a blank url', { palazzoUrl: '   ' }],
    ])('rejects %s', (_n, settings) => {
      const { service } = build();
      expect(() => service['palazzoUrl'](settings)).toThrow(
        new BadGatewayException('Palazzo URL is not configured'),
      );
    });

    it('trims a configured url', () => {
      const { service } = build();
      expect(service['palazzoUrl']({ palazzoUrl: ' http://x ' })).toBe(
        'http://x',
      );
    });
  });

  describe('playSong', () => {
    it('returns not ok when radio settings are missing', async () => {
      const { service, prisma, palazzo } = build();
      prisma.programState.findUnique.mockResolvedValue({
        id: 1,
        radioSettings: null,
      });
      await expect(service.playSong('p', 'u')).resolves.toEqual({ ok: false });
      expect(palazzo.playSong).not.toHaveBeenCalled();
    });

    it('plays with the trimmed supplied request id and returns palazzo ids', async () => {
      const { service, palazzo } = build();
      palazzo.playSong.mockResolvedValue({
        playbackRequestId: 'echo',
        duplicate: false,
        introPlaybackId: 'intro-1',
      });
      const intro = { playbackId: 'i', url: 'iu' };
      await expect(
        service.playSong('p', 'u', 't', 'a', ' req-1 ', 'c', intro),
      ).resolves.toEqual({
        ok: true,
        playbackRequestId: 'echo',
        introPlaybackId: 'intro-1',
      });
      expect(palazzo.playSong).toHaveBeenCalledWith(
        'http://palazzo:3100',
        'p',
        {
          playbackId: 'req-1',
          url: 'u',
          title: 't',
          artist: 'a',
          coverUrl: 'c',
          intro,
        },
      );
    });

    it('generates a request id when none is supplied and reports failures', async () => {
      const { service, palazzo } = build();
      palazzo.playSong.mockRejectedValue(new PalazzoMachineError('rejected'));
      const result = await service.playSong(
        'p',
        'u',
        undefined,
        undefined,
        '  ',
      );
      expect(result.ok).toBe(false);
      expect(result.playbackRequestId).toMatch(/^[0-9a-f-]{36}$/);
      expect(palazzo.playSong.mock.calls[0][2].playbackId).toBe(
        result.playbackRequestId,
      );
      expect(service['logger'].error).toHaveBeenCalledWith({
        event: 'palazzo.machine.failed',
        operation: 'playSong',
        programId: 'p',
        reason: 'rejected',
      });
    });

    it('generates a request id when the argument is omitted', async () => {
      const { service, palazzo } = build();
      palazzo.playSong.mockResolvedValue({ playbackRequestId: 'x' });
      await service.playSong('p', 'u');
      expect(palazzo.playSong.mock.calls[0][2].playbackId).toMatch(
        /^[0-9a-f-]{36}$/,
      );
    });
  });

  describe('machine command wrappers', () => {
    it('stops the song', async () => {
      const { service, palazzo } = build();
      await service.stopSong('p');
      expect(palazzo.stopSong).toHaveBeenCalledWith('http://palazzo:3100', 'p');
    });

    it('maps stop song failures and logs unknown reasons as unavailable', async () => {
      const { service, palazzo } = build();
      palazzo.stopSong.mockRejectedValue(new Error('x'));
      await expect(service.stopSong('p')).rejects.toThrow(
        new BadGatewayException('Palazzo rejected the song stop'),
      );
      expect(service['logger'].error).toHaveBeenCalledWith({
        event: 'palazzo.machine.failed',
        operation: 'stopSong',
        programId: 'p',
        reason: 'unavailable',
      });
    });

    it('plays an instant with a supplied or generated request id', async () => {
      const { service, palazzo } = build();
      await service.playInstant('p', 'u', 0.5, ' pb ');
      expect(palazzo.playInstant).toHaveBeenLastCalledWith(
        'http://palazzo:3100',
        'p',
        { playbackId: 'pb', url: 'u', volume: 0.5 },
      );
      await service.playInstant('p', 'u');
      expect(palazzo.playInstant.mock.calls[1][2].playbackId).toMatch(
        /^[0-9a-f-]{36}$/,
      );
    });

    it('maps instant failures', async () => {
      const { service, palazzo } = build();
      palazzo.playInstant.mockRejectedValue(new Error('x'));
      await expect(service.playInstant('p', 'u')).rejects.toThrow(
        new BadGatewayException('Palazzo rejected the instant'),
      );
    });

    it('updates the mixer and maps failures', async () => {
      const { service, palazzo } = build();
      const mixer = {
        mainVolume: 1,
        songVolume: 1,
        instantVolume: 1,
        songMuted: false,
        instantMuted: false,
      };
      await service.updateMixer('p', mixer);
      expect(palazzo.updateMixer).toHaveBeenCalledWith(
        'http://palazzo:3100',
        'p',
        mixer,
      );
      palazzo.updateMixer.mockRejectedValue(new Error('x'));
      await expect(service.updateMixer('p', mixer)).rejects.toThrow(
        new BadGatewayException('Palazzo rejected the radio mixer update'),
      );
    });

    it('reads playback state and maps failures', async () => {
      const { service, palazzo } = build();
      palazzo.getPlaybackState.mockResolvedValue({ s: 1 });
      await expect(service.getPlaybackState('p')).resolves.toEqual({ s: 1 });
      palazzo.getPlaybackState.mockRejectedValue(new Error('x'));
      await expect(service.getPlaybackState('p')).rejects.toThrow(
        new BadGatewayException('Palazzo playback state is unavailable'),
      );
    });

    it('stops all instants and maps failures', async () => {
      const { service, palazzo } = build();
      await service.stopAllInstants('p');
      expect(palazzo.stopInstants).toHaveBeenCalledWith(
        'http://palazzo:3100',
        'p',
      );
      palazzo.stopInstants.mockRejectedValue(new Error('x'));
      await expect(service.stopAllInstants('p')).rejects.toThrow(
        new BadGatewayException('Palazzo rejected the instant stop'),
      );
    });
  });

  describe('getPalazzoStatus', () => {
    it.each([
      [true, true, true, true],
      [false, true, true, false],
      [true, false, true, false],
      [true, true, false, false],
    ])(
      'liquidsoap running=%s connected=%s icecast=%s gives running=%s',
      async (running, connected, icecast, expected) => {
        const { service, palazzo } = build();
        palazzo.getPlaybackState.mockResolvedValue({
          liquidsoap: { running, connected },
          icecast: { connected: icecast },
        });
        await expect(service.getPalazzoStatus('p')).resolves.toEqual({
          running: expected,
          uptime: null,
        });
      },
    );
  });
});
