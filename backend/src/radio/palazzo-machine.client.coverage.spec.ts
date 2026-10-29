import {
  PalazzoMachineClient,
  PalazzoMachineError,
} from './palazzo-machine.client';

const mockDelay = jest.fn<Promise<void>, [number, unknown, unknown]>();
jest.mock('node:timers/promises', () => ({
  setTimeout: (...args: [number, unknown, unknown]) => mockDelay(...args),
}));

const BASE = 'http://palazzo:3100';
const PROGRAM = 'radio-1';
const ROUTE = `${BASE}/v1/programs/${PROGRAM}`;

const json = (
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

function build(
  values: Record<string, string | undefined> = {},
  fetchImpl: any = jest.fn(),
) {
  const config = {
    get: (key: string) =>
      ({ NODE_ENV: 'test', PALAZZO_ALLOWED_URLS: BASE, ...values })[key],
  };
  const metrics = {
    recordMachineRequest: jest.fn(),
    recordMachineRetry: jest.fn(),
  };
  const client = new PalazzoMachineClient(
    config as any,
    metrics as any,
    fetchImpl === null ? undefined : fetchImpl,
  );
  return { client, metrics, fetchImpl };
}

const expectError = async (
  promise: Promise<unknown>,
  reason: string,
  status?: number,
) => {
  const error = await promise.then(
    () => undefined,
    (e) => e,
  );
  expect(error).toBeInstanceOf(PalazzoMachineError);
  expect(error.reason).toBe(reason);
  expect(error.status).toBe(status);
};

const validState = (intro: unknown = null) => ({
  schemaVersion: 1,
  instanceId: 'inst',
  bootId: 'boot',
  sequence: 1,
  availability: 'available',
  status: 'idle',
  liquidsoap: {
    running: true,
    connected: true,
    staleSince: null,
    lastSampleAt: null,
  },
  icecast: { connected: true },
  track: null,
  intro,
  positionSeconds: 0,
  remainingSeconds: null,
  levels: {
    song: { rms: 0, peak: 0 },
    instant: { rms: 0, peak: 0 },
    output: { rms: 0, peak: 0 },
  },
});

const mixer = {
  mainVolume: 1,
  songVolume: 1,
  instantVolume: 1,
  songMuted: false,
  instantMuted: false,
};

describe('PalazzoMachineClient coverage', () => {
  beforeEach(() => {
    mockDelay.mockReset();
    mockDelay.mockResolvedValue(undefined);
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  describe('construction', () => {
    it('defaults to development when NODE_ENV is absent and uses configured urls', () => {
      const { client } = build({
        NODE_ENV: undefined,
        PALAZZO_ALLOWED_URLS: ' http://a:1 , ,http://b:2/ ',
      });
      expect(client.validateBaseUrl('http://a:1')).toBe('http://a:1');
      expect(client.validateBaseUrl('http://b:2')).toBe('http://b:2');
      expect(() => client.validateBaseUrl(BASE)).toThrow(PalazzoMachineError);
    });

    it('falls back to the compose palazzo url only under NODE_ENV=test', () => {
      expect(
        build({ PALAZZO_ALLOWED_URLS: undefined }).client.validateBaseUrl(BASE),
      ).toBe(BASE);
      expect(
        build({ PALAZZO_ALLOWED_URLS: '   ' }).client.validateBaseUrl(BASE),
      ).toBe(BASE);
    });

    it('refuses to start in other environments without an allowlist', () => {
      expect(() =>
        build({ NODE_ENV: 'production', PALAZZO_ALLOWED_URLS: undefined }),
      ).toThrow('PALAZZO_ALLOWED_URLS must contain an approved URL');
      expect(() =>
        build({ NODE_ENV: 'production', PALAZZO_ALLOWED_URLS: ' , ' }),
      ).toThrow('PALAZZO_ALLOWED_URLS must contain an approved URL');
    });

    it('uses the global fetch when none is injected', async () => {
      const spy = jest
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(json({ ok: true }));
      const { client } = build({}, null);
      await client.stopSong(BASE, PROGRAM);
      expect(spy).toHaveBeenCalledWith(
        `${ROUTE}/playback/song/stop`,
        expect.objectContaining({ method: 'POST' }),
      );
    });
  });

  describe('validateBaseUrl', () => {
    it('rejects unparsable and unapproved urls', () => {
      const { client } = build();
      expect(() => client.validateBaseUrl('not a url')).toThrow(
        PalazzoMachineError,
      );
      expect(() => client.validateBaseUrl('http://other:3100')).toThrow(
        PalazzoMachineError,
      );
    });
  });

  describe('request pipeline', () => {
    it('rejects unapproved base urls and invalid program ids before any I/O', async () => {
      const { client, metrics, fetchImpl } = build();
      await expectError(client.stopSong('http://evil:1', PROGRAM), 'rejected');
      await expectError(client.stopSong(BASE, '../x'), 'rejected');
      await expectError(client.stopSong(BASE, ' '), 'rejected');
      await expectError(client.stopSong(BASE, 'x'.repeat(129)), 'rejected');
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(metrics.recordMachineRequest).toHaveBeenCalledWith(
        'song-stop',
        'rejected',
      );
    });

    it('trims the program id and sends only the headers that apply', async () => {
      const fetchImpl = jest.fn().mockResolvedValue(json({ ok: true }));
      const { client } = build({}, fetchImpl);
      await client.stopSong(BASE, `  ${PROGRAM}  `);
      expect(fetchImpl).toHaveBeenCalledWith(`${ROUTE}/playback/song/stop`, {
        method: 'POST',
        headers: { Accept: 'application/json' },
        body: undefined,
        signal: undefined,
      });
    });

    it('sends body, idempotency, sequence, filler version and event headers', async () => {
      const fetchImpl = jest.fn().mockImplementation(async (url: string) =>
        url.endsWith('/events')
          ? new Response('x', {
              headers: { 'content-type': 'text/event-stream' },
            })
          : json({
              lastSequence: 3,
              readiness: true,
              filler: { activeVersion: 'v1' },
            }),
      );
      const { client } = build({}, fetchImpl);
      await client.commandAutomation(BASE, PROGRAM, 'start', 3, 'key-1', 'v1');
      expect(fetchImpl).toHaveBeenCalledWith(`${ROUTE}/automation/start`, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Idempotency-Key': 'key-1',
          'X-Command-Sequence': '3',
          'X-Filler-Version': 'v1',
        },
        body: undefined,
        signal: undefined,
      });
      await client.connectEvents(
        BASE,
        PROGRAM,
        'evt-9',
        new AbortController().signal,
      );
      expect(fetchImpl.mock.calls[1][1].headers).toEqual({
        Accept: 'text/event-stream',
        'Last-Event-ID': 'evt-9',
      });
    });

    it('serializes request bodies as JSON', async () => {
      const fetchImpl = jest.fn().mockImplementation(async () => json(mixer));
      const { client } = build({}, fetchImpl);
      await client.updateMixer(BASE, PROGRAM, mixer);
      expect(fetchImpl).toHaveBeenCalledWith(`${ROUTE}/mixer`, {
        method: 'PUT',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(mixer),
        signal: undefined,
      });
    });

    it.each([
      [401, 'unauthorized'],
      [403, 'unauthorized'],
      [404, 'rejected'],
    ])(
      'maps %s to %s without retrying a non-retryable request',
      async (status, reason) => {
        const fetchImpl = jest
          .fn()
          .mockResolvedValue(new Response('', { status }));
        const { client, metrics } = build({}, fetchImpl);
        await expectError(client.getAutomation(BASE, PROGRAM), reason, status);
        expect(fetchImpl).toHaveBeenCalledTimes(1);
        expect(metrics.recordMachineRequest).toHaveBeenCalledWith(
          'automation-read',
          reason,
        );
      },
    );

    it('does not retry non-retryable server errors', async () => {
      const fetchImpl = jest
        .fn()
        .mockResolvedValue(new Response('', { status: 503 }));
      const { client } = build({}, fetchImpl);
      await expectError(
        client.playInstant(BASE, PROGRAM, { playbackId: 'p', url: 'u' }),
        'rejected',
        503,
      );
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it('retries retryable requests on 429/5xx with exponential backoff, then succeeds', async () => {
      const fetchImpl = jest
        .fn()
        .mockResolvedValueOnce(new Response('', { status: 429 }))
        .mockResolvedValueOnce(new Response('', { status: 500 }))
        .mockResolvedValueOnce(json({ ok: true }));
      const { client, metrics } = build({}, fetchImpl);
      await client.stopSong(BASE, PROGRAM);
      expect(fetchImpl).toHaveBeenCalledTimes(3);
      expect(metrics.recordMachineRetry).toHaveBeenCalledTimes(2);
      expect(metrics.recordMachineRetry).toHaveBeenCalledWith('song-stop');
      expect(mockDelay.mock.calls.map((c) => c[0])).toEqual([100, 200]);
    });

    it('gives up after the last attempt and reports the final status', async () => {
      const fetchImpl = jest
        .fn()
        .mockResolvedValue(new Response('', { status: 502 }));
      const { client, metrics } = build({}, fetchImpl);
      await expectError(client.stopSong(BASE, PROGRAM), 'rejected', 502);
      expect(fetchImpl).toHaveBeenCalledTimes(3);
      expect(metrics.recordMachineRequest).toHaveBeenCalledWith(
        'song-stop',
        'rejected',
      );
    });

    it('does not retry retryable requests on a non-transient status', async () => {
      const fetchImpl = jest
        .fn()
        .mockResolvedValue(new Response('', { status: 400 }));
      const { client } = build({}, fetchImpl);
      await expectError(client.stopSong(BASE, PROGRAM), 'rejected', 400);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it('tolerates a failing body cancel on error responses', async () => {
      const response = {
        ok: false,
        status: 500,
        body: { cancel: jest.fn().mockRejectedValue(new Error('x')) },
      };
      const fetchImpl = jest.fn().mockResolvedValue(response);
      const { client } = build({}, fetchImpl);
      await expectError(client.getAutomation(BASE, PROGRAM), 'rejected', 500);
      expect(response.body.cancel).toHaveBeenCalled();
    });

    it('reports unavailable immediately for non-retryable network failures', async () => {
      const fetchImpl = jest.fn().mockRejectedValue(new Error('ECONNRESET'));
      const { client, metrics } = build({}, fetchImpl);
      await expectError(client.getAutomation(BASE, PROGRAM), 'unavailable');
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(metrics.recordMachineRequest).toHaveBeenCalledWith(
        'automation-read',
        'unavailable',
      );
    });

    it('retries network failures for retryable requests before reporting unavailable', async () => {
      const fetchImpl = jest.fn().mockRejectedValue(new Error('ECONNRESET'));
      const { client, metrics } = build({}, fetchImpl);
      await expectError(client.stopSong(BASE, PROGRAM), 'unavailable');
      expect(fetchImpl).toHaveBeenCalledTimes(3);
      expect(metrics.recordMachineRetry).toHaveBeenCalledTimes(2);
    });

    it('rethrows the original error when the caller aborted', async () => {
      const abort = new AbortController();
      abort.abort();
      const failure = new Error('aborted');
      const fetchImpl = jest.fn().mockRejectedValue(failure);
      const { client, metrics } = build({}, fetchImpl);
      await expect(client.getMixer(BASE, PROGRAM, abort.signal)).rejects.toBe(
        failure,
      );
      expect(metrics.recordMachineRequest).not.toHaveBeenCalled();
    });

    it('swallows an aborted backoff delay and continues retrying', async () => {
      mockDelay.mockRejectedValue(new Error('delay aborted'));
      const fetchImpl = jest
        .fn()
        .mockResolvedValueOnce(new Response('', { status: 503 }))
        .mockResolvedValueOnce(json({ ok: true }));
      const { client } = build({}, fetchImpl);
      await client.stopSong(BASE, PROGRAM);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    });
  });

  describe('responseJson validation', () => {
    it.each([
      ['non-JSON text', new Response('not json')],
      ['null', json(null)],
      ['a primitive', json(5)],
      ['an array', json([1])],
    ])('treats %s as malformed', async (_n, response) => {
      const { client, metrics } = build(
        {},
        jest.fn().mockResolvedValue(response),
      );
      await expectError(client.stopSong(BASE, PROGRAM), 'malformed');
      expect(metrics.recordMachineRequest).toHaveBeenCalledWith(
        'song-stop',
        'malformed',
      );
    });
  });

  describe('playSong', () => {
    const song = {
      playbackId: 'p1',
      url: 'https://a.test/s.mp3',
      title: 'T',
      artist: 'A',
      coverUrl: 'c',
    };
    const intro = {
      playbackId: 'i1',
      url: 'https://a.test/i.mp3',
      gain: 1,
      duckGain: 0.5,
      fadeInSeconds: 1,
      fadeOutSeconds: 2,
    };
    const run = (body: unknown, command: any = song) => {
      const fetchImpl = jest.fn().mockResolvedValue(json(body));
      const ctx = build({}, fetchImpl);
      return { ...ctx, result: ctx.client.playSong(BASE, PROGRAM, command) };
    };

    it('reports success without an intro', async () => {
      const { result, metrics, fetchImpl } = run({
        ok: true,
        playbackRequestId: 'p1',
      });
      await expect(result).resolves.toEqual({
        playbackRequestId: 'p1',
        duplicate: false,
      });
      expect(metrics.recordMachineRequest).toHaveBeenCalledWith(
        'song-play',
        'success',
      );
      const init = fetchImpl.mock.calls[0][1];
      expect(init.headers['Idempotency-Key']).toBe('p1');
      expect(JSON.parse(init.body)).toEqual({
        song: {
          programId: PROGRAM,
          playbackId: 'p1',
          url: song.url,
          title: 'T',
          artist: 'A',
          coverUrl: 'c',
        },
      });
    });

    it('reports a deduplicated replay', async () => {
      const { result, metrics } = run({
        ok: true,
        playbackRequestId: 'p1',
        duplicate: true,
      });
      await expect(result).resolves.toMatchObject({ duplicate: true });
      expect(metrics.recordMachineRequest).toHaveBeenCalledWith(
        'song-play',
        'deduplicated',
      );
    });

    it('sends and echoes an intro', async () => {
      const { result, fetchImpl } = run(
        { ok: true, playbackRequestId: 'p1', introPlaybackId: 'i1' },
        { ...song, intro },
      );
      await expect(result).resolves.toEqual({
        playbackRequestId: 'p1',
        duplicate: false,
        introPlaybackId: 'i1',
      });
      expect(JSON.parse(fetchImpl.mock.calls[0][1].body).intro).toEqual({
        programId: PROGRAM,
        playbackId: 'i1',
        url: intro.url,
        gain: 1,
        duckGain: 0.5,
        fadeInSeconds: 1,
        fadeOutSeconds: 2,
      });
    });

    it('reports a null intro when palazzo declined it', async () => {
      const { result } = run(
        { ok: true, playbackRequestId: 'p1', introPlaybackId: null },
        { ...song, intro },
      );
      await expect(result).resolves.toMatchObject({ introPlaybackId: null });
    });

    it.each([
      ['ok not true', { ok: false, playbackRequestId: 'p1' }, song],
      ['a different request id', { ok: true, playbackRequestId: 'zz' }, song],
      [
        'a non-boolean duplicate',
        { ok: true, playbackRequestId: 'p1', duplicate: 'y' },
        song,
      ],
      [
        'a non-string intro id',
        { ok: true, playbackRequestId: 'p1', introPlaybackId: 5 },
        song,
      ],
      [
        'an intro id mismatch',
        { ok: true, playbackRequestId: 'p1', introPlaybackId: 'other' },
        { ...song, intro },
      ],
      [
        'a missing intro id when an intro was sent',
        { ok: true, playbackRequestId: 'p1' },
        { ...song, intro },
      ],
    ])('treats %s as malformed', async (_n, body, command) => {
      const { result, metrics } = run(body, command);
      await expectError(result, 'malformed');
      expect(metrics.recordMachineRequest).toHaveBeenCalledWith(
        'song-play',
        'malformed',
      );
    });
  });

  describe('stop commands', () => {
    it('stops instants through the instant route', async () => {
      const fetchImpl = jest.fn().mockResolvedValue(json({ ok: true }));
      const { client, metrics } = build({}, fetchImpl);
      await client.stopInstants(BASE, PROGRAM);
      expect(fetchImpl.mock.calls[0][0]).toBe(`${ROUTE}/playback/instant/stop`);
      expect(metrics.recordMachineRequest).toHaveBeenCalledWith(
        'instant-stop',
        'success',
      );
    });

    it('treats ok:false as malformed', async () => {
      const { client, metrics } = build(
        {},
        jest.fn().mockResolvedValue(json({ ok: false })),
      );
      await expectError(client.stopSong(BASE, PROGRAM), 'malformed');
      expect(metrics.recordMachineRequest).toHaveBeenCalledWith(
        'song-stop',
        'malformed',
      );
      expect(metrics.recordMachineRequest).not.toHaveBeenCalledWith(
        'song-stop',
        'success',
      );
    });
  });

  describe('playInstant', () => {
    const command = { playbackId: 'p', url: 'u', volume: 0.5 };
    it('succeeds on a matching echo', async () => {
      const fetchImpl = jest
        .fn()
        .mockResolvedValue(json({ ok: true, playbackRequestId: 'p' }));
      const { client } = build({}, fetchImpl);
      await expect(client.playInstant(BASE, PROGRAM, command)).resolves.toEqual(
        { playbackRequestId: 'p' },
      );
      expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({
        programId: PROGRAM,
        playbackId: 'p',
        url: 'u',
        volume: 0.5,
      });
    });

    it.each([
      [{ ok: false, playbackRequestId: 'p' }],
      [{ ok: true, playbackRequestId: 'x' }],
    ])('rejects %j as malformed', async (body) => {
      const { client } = build({}, jest.fn().mockResolvedValue(json(body)));
      await expectError(
        client.playInstant(BASE, PROGRAM, command),
        'malformed',
      );
    });
  });

  describe('mixer', () => {
    it('updates and reads the mixer', async () => {
      const fetchImpl = jest.fn().mockImplementation(async () => json(mixer));
      const { client, metrics } = build({}, fetchImpl);
      await expect(client.updateMixer(BASE, PROGRAM, mixer)).resolves.toEqual(
        mixer,
      );
      await expect(client.getMixer(BASE, PROGRAM)).resolves.toEqual(mixer);
      expect(metrics.recordMachineRequest).toHaveBeenCalledWith(
        'mixer-update',
        'success',
      );
      expect(metrics.recordMachineRequest).toHaveBeenCalledWith(
        'mixer-read',
        'success',
      );
    });

    it('rejects malformed mixer payloads', async () => {
      const { client } = build(
        {},
        jest.fn().mockImplementation(async () => json({ mainVolume: 'x' })),
      );
      await expectError(client.updateMixer(BASE, PROGRAM, mixer), 'malformed');
      await expectError(
        client.getMixer(BASE, PROGRAM, new AbortController().signal),
        'malformed',
      );
    });
  });

  describe('getPlaybackState', () => {
    it('returns a parsed state', async () => {
      const { client, metrics } = build(
        {},
        jest.fn().mockResolvedValue(json(validState())),
      );
      await expect(
        client.getPlaybackState(BASE, PROGRAM),
      ).resolves.toMatchObject({ instanceId: 'inst' });
      expect(metrics.recordMachineRequest).toHaveBeenCalledWith(
        'state-read',
        'success',
      );
    });

    it('accepts an intro belonging to the program', async () => {
      const intro = {
        playbackId: 'i',
        parentPlaybackId: 'p',
        programId: PROGRAM,
        playbackRequestId: 'p',
        url: 'u',
        startedAt: '2026-01-01T00:00:00.000Z',
        status: 'playing',
      };
      const { client } = build(
        {},
        jest.fn().mockResolvedValue(json(validState(intro))),
      );
      await expect(
        client.getPlaybackState(BASE, PROGRAM, new AbortController().signal),
      ).resolves.toMatchObject({ intro });
    });

    it('rejects an intro from another program', async () => {
      const intro = {
        playbackId: 'i',
        parentPlaybackId: 'p',
        programId: 'other',
        playbackRequestId: 'p',
        url: 'u',
        startedAt: '2026-01-01T00:00:00.000Z',
        status: 'playing',
      };
      const { client, metrics } = build(
        {},
        jest.fn().mockResolvedValue(json(validState(intro))),
      );
      await expectError(
        client.getPlaybackState(BASE, PROGRAM),
        'cross-program',
      );
      expect(metrics.recordMachineRequest).toHaveBeenCalledWith(
        'state-read',
        'cross-program',
      );
    });

    it('rejects a malformed state', async () => {
      const { client } = build(
        {},
        jest.fn().mockResolvedValue(json({ schemaVersion: 9 })),
      );
      await expectError(client.getPlaybackState(BASE, PROGRAM), 'malformed');
    });
  });

  describe('connectEvents', () => {
    const sse = () =>
      new Response('data', {
        headers: { 'content-type': 'Text/Event-Stream; charset=utf-8' },
      });
    it('returns a stream response without a resume id', async () => {
      const fetchImpl = jest.fn().mockResolvedValue(sse());
      const { client, metrics } = build({}, fetchImpl);
      const response = await client.connectEvents(
        BASE,
        PROGRAM,
        null,
        new AbortController().signal,
      );
      expect(response.ok).toBe(true);
      expect(fetchImpl.mock.calls[0][1].headers).toEqual({
        Accept: 'text/event-stream',
      });
      expect(metrics.recordMachineRequest).toHaveBeenCalledWith(
        'event-connect',
        'success',
      );
    });

    it.each([
      [
        'no body',
        new Response(null, {
          headers: { 'content-type': 'text/event-stream' },
        }),
      ],
      ['no content type', new Response('x')],
      [
        'the wrong content type',
        new Response('x', { headers: { 'content-type': 'application/json' } }),
      ],
    ])('rejects a response with %s', async (_n, response) => {
      const { client } = build({}, jest.fn().mockResolvedValue(response));
      await expectError(
        client.connectEvents(BASE, PROGRAM, null, new AbortController().signal),
        'malformed',
      );
    });
  });

  describe('getAutomation', () => {
    const valid = () => ({
      lastSequence: 4,
      requestedState: 'running',
      actualState: 'running',
      filler: { activeVersion: 'v1', ready: true },
    });
    const run = (change: (b: any) => void) => {
      const body = valid();
      change(body);
      return build(
        {},
        jest.fn().mockResolvedValue(json(body)),
      ).client.getAutomation(BASE, PROGRAM);
    };

    it('returns parsed automation with a null or string active version', async () => {
      await expect(run(() => undefined)).resolves.toEqual(valid());
      await expect(
        run((b) => (b.filler.activeVersion = null)),
      ).resolves.toMatchObject({
        filler: { activeVersion: null, ready: true },
      });
    });

    it.each<[string, (b: any) => void]>([
      ['a non-integer sequence', (b) => (b.lastSequence = 1.5)],
      ['a non-string requested state', (b) => (b.requestedState = 1)],
      ['a non-string actual state', (b) => (b.actualState = 1)],
      ['a missing filler', (b) => delete b.filler],
      ['a non-object filler', (b) => (b.filler = 'x')],
      ['a non-string active version', (b) => (b.filler.activeVersion = 5)],
      ['a non-boolean ready flag', (b) => (b.filler.ready = 'yes')],
    ])('rejects %s', async (_n, change) => {
      await expectError(run(change), 'malformed');
    });
  });

  describe('prepareFiller', () => {
    const assets = [
      { id: 'song-1', sha256: 'abc', downloadUrl: 'https://a.test/a.mp3' },
    ];
    it('prepares a filler with an encoded version route', async () => {
      const fetchImpl = jest
        .fn()
        .mockResolvedValue(
          json({ version: 'v 1', ready: true, status: 'ready' }),
        );
      const { client, metrics } = build({}, fetchImpl);
      await client.prepareFiller(BASE, PROGRAM, 'v 1', assets);
      expect(fetchImpl.mock.calls[0][0]).toBe(`${ROUTE}/fillers/v%201`);
      expect(fetchImpl.mock.calls[0][1].method).toBe('PUT');
      expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({
        commandId: 'v 1',
        mode: 'ordered',
        assets,
      });
      expect(metrics.recordMachineRequest).toHaveBeenCalledWith(
        'filler-prepare',
        'success',
      );
    });

    it.each([
      [{ version: 'other', ready: true, status: 'ready' }],
      [{ version: 'v1', ready: false, status: 'ready' }],
      [{ version: 'v1', ready: true, status: 'pending' }],
    ])('rejects %j', async (body) => {
      const { client } = build({}, jest.fn().mockResolvedValue(json(body)));
      await expectError(
        client.prepareFiller(BASE, PROGRAM, 'v1', assets),
        'malformed',
      );
    });
  });

  describe('commandAutomation', () => {
    const run = (action: 'start' | 'stop', body: unknown, version?: string) =>
      build(
        {},
        jest.fn().mockResolvedValue(json(body)),
      ).client.commandAutomation(BASE, PROGRAM, action, 7, 'key', version);

    it('accepts a matching start and stop acknowledgement', async () => {
      await expect(
        run(
          'start',
          { lastSequence: 7, readiness: true, filler: { activeVersion: 'v1' } },
          'v1',
        ),
      ).resolves.toBeUndefined();
      await expect(run('stop', { lastSequence: 7 })).resolves.toBeUndefined();
    });

    it.each([
      [
        'a sequence mismatch on start',
        'start',
        { lastSequence: 6, readiness: true, filler: { activeVersion: 'v1' } },
      ],
      [
        'readiness not true',
        'start',
        { lastSequence: 7, readiness: false, filler: { activeVersion: 'v1' } },
      ],
      ['a missing filler', 'start', { lastSequence: 7, readiness: true }],
      [
        'a different active version',
        'start',
        { lastSequence: 7, readiness: true, filler: { activeVersion: 'v2' } },
      ],
      ['a sequence mismatch on stop', 'stop', { lastSequence: 1 }],
    ] as const)('rejects %s', async (_n, action, body) => {
      await expectError(run(action, body, 'v1'), 'malformed');
    });
  });

  describe('openOutput', () => {
    const audio = () =>
      new Response('audio', { headers: { 'content-type': 'audio/mpeg' } });

    it('returns the live audio response', async () => {
      const fetchImpl = jest.fn().mockResolvedValue(audio());
      const { client, metrics } = build({}, fetchImpl);
      const response = await client.openOutput(
        BASE,
        PROGRAM,
        new AbortController().signal,
      );
      expect(await response.text()).toBe('audio');
      expect(fetchImpl.mock.calls[0][1].headers.Accept).toBe('audio/*');
      expect(metrics.recordMachineRequest).toHaveBeenCalledWith(
        'output-monitor',
        'success',
      );
    });

    it.each([
      [
        'no body',
        new Response(null, { headers: { 'content-type': 'audio/mpeg' } }),
      ],
      ['no content type', new Response('x')],
      [
        'a non-audio content type',
        new Response('x', { headers: { 'content-type': 'text/html' } }),
      ],
    ])('rejects a response with %s', async (_n, response) => {
      const { client, metrics } = build(
        {},
        jest.fn().mockResolvedValue(response),
      );
      await expectError(
        client.openOutput(BASE, PROGRAM, new AbortController().signal),
        'malformed',
      );
      expect(metrics.recordMachineRequest).toHaveBeenCalledWith(
        'output-monitor',
        'malformed',
      );
    });

    it('does not mark a failed request as a timeout when it failed for another reason', async () => {
      const fetchImpl = jest.fn().mockRejectedValue(new Error('refused'));
      const { client, metrics } = build({}, fetchImpl);
      await expectError(
        client.openOutput(BASE, PROGRAM, new AbortController().signal),
        'unavailable',
      );
      expect(metrics.recordMachineRequest).toHaveBeenCalledTimes(1);
      expect(metrics.recordMachineRequest).toHaveBeenCalledWith(
        'output-monitor',
        'unavailable',
      );
    });

    it('records unavailable when connection establishment times out', async () => {
      jest.useFakeTimers();
      const fetchImpl = jest
        .fn()
        .mockImplementation(
          (_url: string, init: { signal: AbortSignal }) =>
            new Promise((_resolve, reject) =>
              init.signal.addEventListener('abort', () =>
                reject(new Error('aborted')),
              ),
            ),
        );
      const { client, metrics } = build({}, fetchImpl);
      const outcome = client
        .openOutput(BASE, PROGRAM, new AbortController().signal)
        .then(
          () => undefined,
          (e) => e,
        );
      await jest.advanceTimersByTimeAsync(10_000);
      expect(await outcome).toEqual(new Error('aborted'));
      expect(metrics.recordMachineRequest).toHaveBeenCalledWith(
        'output-monitor',
        'unavailable',
      );
    });

    it('does not record a timeout when the caller aborted first', async () => {
      const abort = new AbortController();
      const fetchImpl = jest
        .fn()
        .mockImplementation(
          (_url: string, init: { signal: AbortSignal }) =>
            new Promise((_resolve, reject) =>
              init.signal.addEventListener('abort', () =>
                reject(new Error('aborted')),
              ),
            ),
        );
      const { client, metrics } = build({}, fetchImpl);
      const outcome = client.openOutput(BASE, PROGRAM, abort.signal).then(
        () => undefined,
        (e) => e,
      );
      abort.abort();
      expect(await outcome).toEqual(new Error('aborted'));
      expect(metrics.recordMachineRequest).not.toHaveBeenCalled();
    });
  });
});
