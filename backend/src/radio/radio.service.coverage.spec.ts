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
    song: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn().mockResolvedValue(null),
      findFirst: jest.fn().mockResolvedValue(null),
    },
    mediaAssetAnalysis: {
      findUnique: jest.fn().mockResolvedValue(null),
    },
    // No program radio filler configured (gaulatti/alcantara#126).
    fillerLeg: { findUnique: jest.fn().mockResolvedValue(null) },
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
    recordAnalysisDrop: jest.fn(),
    recordCueGroup: jest.fn(),
    recordEngineDegraded: jest.fn(),
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
          segueMode: 'on',
        },
      });
      expect(metrics.recordListenerConfiguration).not.toHaveBeenCalled();
    });

    it('creates a new program with segue on but keeps an explicit off', async () => {
      const created = build();
      await created.service.updateRadioSettings('p', { enabled: true });
      const createdArg = created.prisma.radioSettings.upsert.mock.calls[0][0];
      expect(createdArg.create.segueMode).toBe('on');
      // An update that does not name segueMode never touches the stored choice.
      expect(createdArg.update).not.toHaveProperty('segueMode');

      const optedOut = build();
      await optedOut.service.updateRadioSettings('p', { segueMode: 'off' });
      const optedOutArg = optedOut.prisma.radioSettings.upsert.mock.calls[0][0];
      expect(optedOutArg.create.segueMode).toBe('off');
      expect(optedOutArg.update.segueMode).toBe('off');
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
        segueMode: 'on',
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
        segueMode: 'on',
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
        segueMode: 'on',
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
        [
          'unknown segueMode',
          { segueMode: 'shuffle' },
          'segueMode must be off or on',
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
      const { service, prisma, palazzo, metrics } = build();
      const warn = jest
        .spyOn(service['logger'], 'warn')
        .mockImplementation(() => undefined);
      prisma.programState.findUnique.mockResolvedValue({
        id: 1,
        radioSettings: null,
      });
      await expect(service.playSong('p', 'u')).resolves.toEqual({ ok: false });
      expect(palazzo.playSong).not.toHaveBeenCalled();
      // #237: said once and counted, never silent.
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith('Radio settings missing for program p');
      expect(metrics.recordEngineDegraded).toHaveBeenCalledTimes(1);
      expect(metrics.recordEngineDegraded).toHaveBeenCalledWith(
        'radio_settings_missing',
      );
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

    it('ignores analysis when segueMode is off', async () => {
      const { service, prisma, palazzo } = build({
        ...defaultSettings(),
        segueMode: 'off',
      });
      palazzo.playSong.mockResolvedValue({ playbackRequestId: 'song-1' });
      prisma.song.findUnique.mockResolvedValue({
        id: 101,
        assetId: 'asset-1',
        durationMs: 200000,
      });
      prisma.mediaAssetAnalysis.findUnique.mockResolvedValue({
        status: 'success',
        cueInSeconds: 0.5,
        cueOutSeconds: 199.0,
        fadeInSeconds: 0.1,
        fadeOutSeconds: 1.5,
        overlapSeconds: 2.0,
        integratedLufs: -14.0,
        truePeakDbtp: -1.0,
      });

      await service.playSong(
        'p',
        'u',
        'title',
        'artist',
        'song-1',
        undefined,
        undefined,
        101,
      );

      expect(palazzo.playSong).toHaveBeenCalledWith(
        'http://palazzo:3100',
        'p',
        {
          playbackId: 'song-1',
          url: 'u',
          title: 'title',
          artist: 'artist',
        },
      );
    });

    it('attaches segue and loudness when segueMode is on and analysis succeeds', async () => {
      const { service, prisma, palazzo } = build({
        ...defaultSettings(),
        segueMode: 'on',
      });
      palazzo.playSong.mockResolvedValue({ playbackRequestId: 'song-1' });
      prisma.song.findUnique.mockResolvedValue({
        id: 101,
        assetId: 'asset-1',
        durationMs: 200000,
      });
      prisma.mediaAssetAnalysis.findUnique.mockResolvedValue({
        status: 'success',
        cueInSeconds: 0.5,
        cueOutSeconds: 199.0,
        fadeInSeconds: 0.1,
        fadeOutSeconds: 1.5,
        overlapSeconds: 2.0,
        integratedLufs: -14.0,
        truePeakDbtp: -1.0,
      });

      await service.playSong(
        'p',
        'u',
        'title',
        'artist',
        'song-1',
        undefined,
        undefined,
        101,
        200,
      );

      expect(palazzo.playSong).toHaveBeenCalledWith(
        'http://palazzo:3100',
        'p',
        {
          playbackId: 'song-1',
          url: 'u',
          title: 'title',
          artist: 'artist',
          duration: 200,
          segue: {
            cueInSeconds: 0.5,
            cueOutSeconds: 199.0,
            fadeInSeconds: 0.1,
            fadeOutSeconds: 1.5,
            overlapSeconds: 2.0,
          },
          loudness: {
            integratedLufs: -14.0,
            truePeakDbtp: -1.0,
          },
        },
      );
    });

    it('resolves analysis via audioUrl fallback when songId is omitted', async () => {
      const { service, prisma, palazzo } = build({
        ...defaultSettings(),
        segueMode: 'on',
      });
      palazzo.playSong.mockResolvedValue({ playbackRequestId: 'song-1' });
      prisma.song.findMany.mockResolvedValue([
        { assetId: 'asset-2', durationMs: 180000 },
      ]);
      prisma.mediaAssetAnalysis.findUnique.mockResolvedValue({
        status: 'success',
        cueInSeconds: 1.0,
        cueOutSeconds: 175.0,
        fadeInSeconds: null,
        fadeOutSeconds: null,
        overlapSeconds: null,
        integratedLufs: null,
        truePeakDbtp: null,
      });

      await service.playSong('p', 'https://media.example/song.mp3');

      expect(palazzo.playSong).toHaveBeenCalledWith(
        'http://palazzo:3100',
        'p',
        expect.objectContaining({
          segue: {
            cueInSeconds: 1.0,
            cueOutSeconds: 175.0,
            fadeInSeconds: 0,
            fadeOutSeconds: 0,
            overlapSeconds: 0,
          },
        }),
      );
    });

    it('does not block playback when analysis row is missing or failed or throws', async () => {
      const { service, prisma, palazzo } = build({
        ...defaultSettings(),
        segueMode: 'on',
      });
      palazzo.playSong.mockResolvedValue({ playbackRequestId: 'song-1' });

      // Case 1: no song found
      prisma.song.findUnique.mockResolvedValueOnce(null);
      await expect(
        service.playSong('p', 'u', undefined, undefined, 'req-1', undefined, undefined, 999),
      ).resolves.toEqual({ ok: true, playbackRequestId: 'song-1' });

      // Case 2: song has no assetId
      prisma.song.findUnique.mockResolvedValueOnce({ id: 101, assetId: null });
      await expect(
        service.playSong('p', 'u', undefined, undefined, 'req-2', undefined, undefined, 101),
      ).resolves.toEqual({ ok: true, playbackRequestId: 'song-1' });

      // Case 3: analysis row is failed
      prisma.song.findUnique.mockResolvedValueOnce({ id: 101, assetId: 'asset-failed' });
      prisma.mediaAssetAnalysis.findUnique.mockResolvedValueOnce({
        status: 'failed',
        error: 'corrupt file',
      });
      await expect(
        service.playSong('p', 'u', undefined, undefined, 'req-3', undefined, undefined, 101),
      ).resolves.toEqual({ ok: true, playbackRequestId: 'song-1' });

      // Case 4: analysis query throws
      prisma.song.findUnique.mockResolvedValueOnce({ id: 101, assetId: 'asset-err' });
      prisma.mediaAssetAnalysis.findUnique.mockRejectedValueOnce(new Error('db connection lost'));
      await expect(
        service.playSong('p', 'u', undefined, undefined, 'req-4', undefined, undefined, 101),
      ).resolves.toEqual({ ok: true, playbackRequestId: 'song-1' });
    });
  });

  describe('playSong analysis validation (segueMode on)', () => {
    const OFF_COMMAND = { playbackId: 'req', url: 'u', title: undefined, artist: undefined, coverUrl: undefined, intro: undefined };
    const VALID_SEGUE = { cueInSeconds: 1, cueOutSeconds: 170, fadeInSeconds: 0.5, fadeOutSeconds: 2, overlapSeconds: 3 };
    const VALID_LOUDNESS = { integratedLufs: -14, truePeakDbtp: -1 };
    const NO_SEGUE = { cueInSeconds: null, cueOutSeconds: null, fadeInSeconds: null, fadeOutSeconds: null, overlapSeconds: null };
    const NO_LOUDNESS = { integratedLufs: null, truePeakDbtp: null };

    function onWithAnalysis(analysis: Record<string, unknown>, durationMs: number | null = 180000) {
      const built = build({ ...defaultSettings(), segueMode: 'on' });
      built.palazzo.playSong.mockResolvedValue({ playbackRequestId: 'req' });
      built.prisma.song.findUnique.mockResolvedValue({ assetId: 'asset-1', durationMs });
      built.prisma.mediaAssetAnalysis.findUnique.mockResolvedValue({ status: 'success', ...analysis });
      jest.spyOn(built.service['logger'], 'warn').mockImplementation();
      return built;
    }
    const sent = (palazzo: any) => palazzo.playSong.mock.calls.at(-1)[2];
    const play = (service: any) => service.playSong('p', 'u', undefined, undefined, 'req', undefined, undefined, 7);

    it.each([
      ['loudness below -70 LUFS', { ...NO_SEGUE, integratedLufs: -71, truePeakDbtp: -1 }, 'loudness-invalid'],
      ['true peak above +6 dBTP', { ...NO_SEGUE, integratedLufs: -14, truePeakDbtp: 6.5 }, 'loudness-invalid'],
      ['overlap longer than the cue span', { ...NO_LOUDNESS, ...VALID_SEGUE, cueInSeconds: 1, cueOutSeconds: 175, overlapSeconds: 175 }, 'segue-invalid'],
    ])('drops %s and sends the segueMode-off command, so the song plays', async (_name, analysis, reason) => {
      const { service, palazzo, metrics } = onWithAnalysis(analysis);
      await expect(play(service)).resolves.toEqual({ ok: true, playbackRequestId: 'req' });
      expect(sent(palazzo)).toEqual(OFF_COMMAND);
      expect(metrics.recordAnalysisDrop).toHaveBeenCalledWith(reason);
      expect(metrics.recordAnalysisDrop).toHaveBeenCalledTimes(1);
    });

    it('drops an invalid edge on its own (#234), keeping the valid edge and loudness', async () => {
      // An invalid cue-in (negative, or past the bound) is not applied; the valid cue-out still is.
      for (const cueInSeconds of [-1, 170]) {
        const { service, palazzo, metrics } = onWithAnalysis({ ...VALID_SEGUE, cueInSeconds, ...VALID_LOUDNESS });
        await play(service);
        expect(sent(palazzo)).toEqual({ ...OFF_COMMAND, duration: 180, loudness: VALID_LOUDNESS, segue: { ...VALID_SEGUE, cueInSeconds: 0 } });
        expect(metrics.recordAnalysisDrop).toHaveBeenCalledWith('segue-edge-bound');
        expect(metrics.recordCueGroup).toHaveBeenCalledWith('head_filled');
      }
    });

    it('drops invalid loudness but keeps valid cue points', async () => {
      const { service, palazzo, metrics } = onWithAnalysis({ ...VALID_SEGUE, integratedLufs: Number.NaN, truePeakDbtp: -1 });
      await play(service);
      expect(sent(palazzo)).toEqual({ ...OFF_COMMAND, duration: 180, segue: VALID_SEGUE });
      expect(metrics.recordAnalysisDrop).toHaveBeenCalledWith('loudness-invalid');
    });

    it('treats a cue-out beyond the song duration as no tail trim, keeping the head (#234)', async () => {
      const { service, palazzo, metrics } = onWithAnalysis({ ...VALID_SEGUE, ...VALID_LOUDNESS }, 150000);
      await play(service);
      expect(sent(palazzo)).toEqual({ ...OFF_COMMAND, duration: 150, loudness: VALID_LOUDNESS, segue: { ...VALID_SEGUE, cueOutSeconds: 150 } });
      expect(metrics.recordAnalysisDrop).toHaveBeenCalledWith('segue-edge-bound');
      // Within the duration the same segue is kept, and a song with no stored duration is not bounded.
      const within = onWithAnalysis({ ...VALID_SEGUE, ...NO_LOUDNESS }, 170000);
      await play(within.service);
      expect(sent(within.palazzo)).toEqual({ ...OFF_COMMAND, duration: 170, segue: VALID_SEGUE });
      const unknown = onWithAnalysis({ ...VALID_SEGUE, ...NO_LOUDNESS }, null);
      await play(unknown.service);
      // No stored duration: none is sent, and Palazzo applies the cue-out as sent.
      expect(sent(unknown.palazzo)).toEqual({ ...OFF_COMMAND, segue: VALID_SEGUE });
      expect(unknown.metrics.recordAnalysisDrop).not.toHaveBeenCalled();
    });

    // gaulatti/alcantara#234: one measured edge is enough. The other is filled
    // (cue-in 0, cue-out the duration), each edge is bounded at 10 s, and
    // the group's shape is counted.
    it.each([
      ['a tail-only song (the 536)', { cueInSeconds: null, cueOutSeconds: 176 }, { cueInSeconds: 0, cueOutSeconds: 176 }, 'head_filled'],
      ['a head-only song (the 13)', { cueInSeconds: 2.5, cueOutSeconds: null }, { cueInSeconds: 2.5, cueOutSeconds: 180 }, 'tail_filled'],
      ['a song with both edges', { cueInSeconds: 1, cueOutSeconds: 177 }, { cueInSeconds: 1, cueOutSeconds: 177 }, 'both'],
    ])('sends a full cue group for %s', async (_name, cues, expected, shape) => {
      const { service, palazzo, metrics } = onWithAnalysis({ ...NO_LOUDNESS, fadeInSeconds: null, fadeOutSeconds: null, overlapSeconds: null, ...cues });
      await play(service);
      expect(sent(palazzo)).toEqual({
        ...OFF_COMMAND,
        // The duration the group was checked against, so Palazzo bounds and counts the tail.
        duration: 180,
        segue: { ...expected, fadeInSeconds: 0, fadeOutSeconds: 0, overlapSeconds: 0 },
      });
      expect(metrics.recordCueGroup).toHaveBeenCalledWith(shape);
      expect(metrics.recordAnalysisDrop).not.toHaveBeenCalled();
    });

    it('does not apply an edge that would trim more than 10 s, and counts it', async () => {
      // Tail of 12 s (cue-out 168 of 180) is over the bound; the head of 2 s is kept.
      const { service, palazzo, metrics } = onWithAnalysis({ ...NO_LOUDNESS, fadeInSeconds: null, fadeOutSeconds: null, overlapSeconds: null, cueInSeconds: 2, cueOutSeconds: 168 });
      await play(service);
      expect(sent(palazzo).segue).toEqual({ cueInSeconds: 2, cueOutSeconds: 180, fadeInSeconds: 0, fadeOutSeconds: 0, overlapSeconds: 0 });
      expect(sent(palazzo).duration).toBe(180);
      expect(metrics.recordAnalysisDrop).toHaveBeenCalledWith('segue-edge-bound');
      expect(metrics.recordCueGroup).toHaveBeenCalledWith('tail_filled');
      // Both edges over the bound: no group at all.
      const both = onWithAnalysis({ ...NO_LOUDNESS, cueInSeconds: 11, cueOutSeconds: 160 });
      await play(both.service);
      expect(sent(both.palazzo)).toEqual(OFF_COMMAND);
      expect(both.metrics.recordAnalysisDrop.mock.calls).toEqual([['segue-edge-bound'], ['segue-edge-bound']]);
      expect(both.metrics.recordCueGroup).toHaveBeenCalledWith('none');
    });

    it('treats a cue-out past the stored duration as no tail trim and keeps the head', async () => {
      // durationMs 180 s, analysed cue-out 181.2 s: the file is a little longer than the stored duration.
      const { service, palazzo, metrics } = onWithAnalysis({ ...NO_LOUDNESS, fadeInSeconds: null, fadeOutSeconds: null, overlapSeconds: null, cueInSeconds: 1.5, cueOutSeconds: 181.2 });
      await play(service);
      expect(sent(palazzo).segue).toEqual({ cueInSeconds: 1.5, cueOutSeconds: 180, fadeInSeconds: 0, fadeOutSeconds: 0, overlapSeconds: 0 });
      expect(metrics.recordAnalysisDrop.mock.calls).toEqual([['segue-edge-bound']]);
      expect(metrics.recordCueGroup).toHaveBeenCalledWith('tail_filled');
    });

    it('keeps today\'s behaviour without a stored duration: both measured cues or none', async () => {
      const tailOnly = onWithAnalysis({ ...NO_LOUDNESS, cueInSeconds: null, cueOutSeconds: 176 }, null);
      await play(tailOnly.service);
      expect(sent(tailOnly.palazzo)).toEqual(OFF_COMMAND);
      expect(tailOnly.metrics.recordCueGroup).toHaveBeenCalledWith('none');
    });

    it('counts a song analysed with neither edge as none', async () => {
      const { service, palazzo, metrics } = onWithAnalysis({ ...NO_LOUDNESS, cueInSeconds: null, cueOutSeconds: null });
      await play(service);
      expect(sent(palazzo)).toEqual(OFF_COMMAND);
      expect(metrics.recordCueGroup).toHaveBeenCalledWith('none');
    });

    it('applies no analysis when more than one song shares the audio URL', async () => {
      const { service, prisma, palazzo, metrics } = onWithAnalysis({ ...VALID_SEGUE, ...VALID_LOUDNESS });
      prisma.song.findMany.mockResolvedValue([
        { assetId: 'asset-1', durationMs: 180000 },
        { assetId: 'asset-2', durationMs: 180000 },
      ]);
      await expect(service.playSong('p', 'u', undefined, undefined, 'req')).resolves.toEqual({ ok: true, playbackRequestId: 'req' });
      expect(prisma.song.findMany).toHaveBeenCalledWith({ where: { audioUrl: 'u' }, select: { assetId: true, durationMs: true }, take: 2 });
      expect(prisma.mediaAssetAnalysis.findUnique).not.toHaveBeenCalled();
      expect(sent(palazzo)).toEqual(OFF_COMMAND);
      expect(metrics.recordAnalysisDrop).toHaveBeenCalledWith('ambiguous-match');
    });

    it('applies no analysis and records no drop when no song has the audio URL', async () => {
      const { service, prisma, palazzo, metrics } = onWithAnalysis({ ...VALID_SEGUE, ...VALID_LOUDNESS });
      prisma.song.findMany.mockResolvedValue([]);
      await expect(service.playSong('p', 'u', undefined, undefined, 'req')).resolves.toEqual({ ok: true, playbackRequestId: 'req' });
      expect(prisma.mediaAssetAnalysis.findUnique).not.toHaveBeenCalled();
      expect(sent(palazzo)).toEqual(OFF_COMMAND);
      expect(metrics.recordAnalysisDrop).not.toHaveBeenCalled();
    });

    it('also validates segue and loudness the caller supplies', async () => {
      const { service, prisma, palazzo, metrics } = onWithAnalysis({});
      await service.playSong('p', 'u', undefined, undefined, 'req', undefined, undefined, undefined, 100, { ...VALID_SEGUE, cueOutSeconds: 120 }, { integratedLufs: -80, truePeakDbtp: 0 });
      expect(prisma.song.findUnique).not.toHaveBeenCalled();
      expect(sent(palazzo)).toEqual({ ...OFF_COMMAND, duration: 100 });
      expect(metrics.recordAnalysisDrop.mock.calls).toEqual([['segue-beyond-duration'], ['loudness-invalid']]);
    });

    it('counts every drop and logs once per song with the reasons and no audio URL', async () => {
      const { service, metrics } = onWithAnalysis({ ...VALID_SEGUE, cueInSeconds: 200, integratedLufs: 1, truePeakDbtp: 0 });
      await play(service);
      expect(metrics.recordAnalysisDrop.mock.calls).toEqual([['segue-edge-bound'], ['loudness-invalid']]);
      expect(service['logger'].warn).toHaveBeenCalledTimes(1);
      expect(service['logger'].warn).toHaveBeenCalledWith({
        event: 'radio.song_analysis_dropped',
        programId: 'p',
        playbackRequestId: 'req',
        songId: 7,
        reasons: ['segue-edge-bound', 'loudness-invalid'],
      });
      expect(JSON.stringify((service['logger'].warn as jest.Mock).mock.calls)).not.toContain('"u"');
    });

    it.each([
      ['the song has no asset', () => ({ songRow: { assetId: null, durationMs: 180000 }, analysisRow: null })],
      ['the asset has no analysis row', () => ({ songRow: { assetId: 'asset-1', durationMs: 180000 }, analysisRow: null })],
      ['the analysis is still pending', () => ({ songRow: { assetId: 'asset-1', durationMs: 180000 }, analysisRow: { status: 'pending', ...NO_SEGUE, ...NO_LOUDNESS } })],
      ['the analysis has no measurements', () => ({ songRow: { assetId: 'asset-1', durationMs: 180000 }, analysisRow: { status: 'success', ...NO_SEGUE, ...NO_LOUDNESS } })],
    ])('plays a song whose %s with the same command segue off sends', async (_name, fixture) => {
      const { songRow, analysisRow } = fixture();
      const on = build({ ...defaultSettings(), segueMode: 'on' });
      const off = build({ ...defaultSettings(), segueMode: 'off' });
      for (const built of [on, off]) {
        built.palazzo.playSong.mockResolvedValue({ playbackRequestId: 'req' });
        built.prisma.song.findUnique.mockResolvedValue(songRow);
        built.prisma.mediaAssetAnalysis.findUnique.mockResolvedValue(analysisRow);
        jest.spyOn(built.service['logger'], 'warn').mockImplementation();
        await expect(play(built.service)).resolves.toEqual({ ok: true, playbackRequestId: 'req' });
      }
      expect(JSON.stringify(on.palazzo.playSong.mock.calls)).toBe(JSON.stringify(off.palazzo.playSong.mock.calls));
      expect(sent(on.palazzo)).toEqual(OFF_COMMAND);
      expect(on.metrics.recordAnalysisDrop).not.toHaveBeenCalled();
      expect(on.service['logger'].warn).not.toHaveBeenCalled();
    });

    it('logs nothing and counts nothing when the analysis is valid', async () => {
      const { service, palazzo, metrics } = onWithAnalysis({ ...VALID_SEGUE, ...VALID_LOUDNESS });
      await play(service);
      expect(sent(palazzo)).toEqual({ ...OFF_COMMAND, duration: 180, segue: VALID_SEGUE, loudness: VALID_LOUDNESS });
      expect(metrics.recordAnalysisDrop).not.toHaveBeenCalled();
      expect(service['logger'].warn).not.toHaveBeenCalled();
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
