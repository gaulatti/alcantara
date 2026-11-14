import { ConfigService } from '@nestjs/config';
import { PalazzoMachineClient } from './palazzo-machine.client';
import { RadioMetricsService } from './radio-metrics.service';
import { setTimeout as delay } from 'node:timers/promises';

jest.mock('node:timers/promises', () => ({
  setTimeout: jest.fn().mockResolvedValue(undefined),
}));

const base = 'http://palazzo:3100';
const program = 'radio-1';
const mixer = {
  mainVolume: 1,
  songVolume: 0.5,
  instantVolume: 0.7,
  songMuted: false,
  instantMuted: false,
};
function fixture(
  fetcher: jest.Mock = jest.fn(),
  values: Record<string, string | undefined> = {},
) {
  const config = {
    get: (key: string) => ({ PALAZZO_ALLOWED_URLS: base, ...values })[key],
  } as unknown as ConfigService;
  const metrics = new RadioMetricsService();
  return {
    client: new PalazzoMachineClient(
      config,
      metrics,
      fetcher as unknown as typeof fetch,
    ),
    metrics,
    fetcher,
  };
}

describe('private Palazzo transport rejection, retry and streaming boundaries', () => {
  beforeEach(() => jest.clearAllMocks());

  it('normalizes explicit allowlisted origins with the default development environment', () => {
    const { client } = fixture();
    expect(client.validateBaseUrl(`${base}/`)).toBe(base);
    expect(() => client.validateBaseUrl('malformed origin')).toThrow(
      'rejected',
    );
    expect(() => client.validateBaseUrl('http://unapproved:3100')).toThrow(
      'rejected',
    );
  });

  it.each([
    { ok: false, playbackRequestId: 'song' },
    { ok: true, playbackRequestId: 'another' },
    { ok: true, playbackRequestId: 'song', duplicate: 'true' },
    { ok: true, playbackRequestId: 'song', introPlaybackId: 4 },
    { ok: true, playbackRequestId: 'song', introPlaybackId: 'other' },
    { ok: true, playbackRequestId: 'song' },
  ])(
    'rejects an acknowledgement that cannot bind the requested song and intro: %j',
    async (body) => {
      const { client, metrics } = fixture(
        jest.fn().mockResolvedValue(Response.json(body)),
      );
      await expect(
        client.playSong(base, program, {
          playbackId: 'song',
          url: 'https://media.invalid/song',
          intro: { playbackId: 'intro', url: 'https://media.invalid/intro' },
        }),
      ).rejects.toMatchObject({ reason: 'malformed' });
      expect(metrics.snapshot().machineRequests['song-play:malformed']).toBe(1);
    },
  );

  it('accepts an explicitly absent intro without fabricating an intro playback identifier', async () => {
    const { client } = fixture(
      jest.fn().mockResolvedValue(
        Response.json({
          ok: true,
          playbackRequestId: 'song',
          introPlaybackId: null,
        }),
      ),
    );
    await expect(
      client.playSong(base, program, {
        playbackId: 'song',
        url: 'https://media.invalid/song',
        intro: { playbackId: 'intro', url: 'https://media.invalid/intro' },
      }),
    ).resolves.toEqual({
      playbackRequestId: 'song',
      duplicate: false,
      introPlaybackId: null,
    });
  });

  it.each(['null', '[]', '"unexpected"', '{'])(
    'fails malformed response JSON safely: %s',
    async (body) => {
      const { client } = fixture(
        jest.fn().mockResolvedValue(new Response(body)),
      );
      await expect(client.stopSong(base, program)).rejects.toMatchObject({
        reason: 'malformed',
      });
    },
  );

  it.each([{ ok: false }, { ok: true, playbackRequestId: 'other' }])(
    'rejects a mismatched instant acknowledgement: %j',
    async (body) => {
      const { client } = fixture(
        jest.fn().mockResolvedValue(Response.json(body)),
      );
      await expect(
        client.playInstant(base, program, {
          playbackId: 'instant',
          url: 'https://media.invalid/instant',
        }),
      ).rejects.toMatchObject({ reason: 'malformed' });
    },
  );

  it.each(['get', 'update'] as const)(
    'rejects invalid mixer schema from %s',
    async (method) => {
      const { client } = fixture(
        jest.fn().mockResolvedValue(Response.json({ mainVolume: 'full' })),
      );
      const request =
        method === 'get'
          ? client.getMixer(base, program)
          : client.updateMixer(base, program, mixer);
      await expect(request).rejects.toMatchObject({ reason: 'malformed' });
    },
  );

  const validAutomation = {
    lastSequence: 4,
    requestedState: 'stopped',
    actualState: 'stopped',
    filler: { activeVersion: null, ready: false },
  };
  it.each([
    { ...validAutomation, lastSequence: 0.5 },
    { ...validAutomation, requestedState: false },
    { ...validAutomation, actualState: false },
    { ...validAutomation, filler: null },
    { ...validAutomation, filler: 'ready' },
    { ...validAutomation, filler: { activeVersion: 4, ready: true } },
    { ...validAutomation, filler: { activeVersion: null, ready: 'yes' } },
  ])('rejects incomplete automation state: %j', async (body) => {
    const { client } = fixture(
      jest.fn().mockResolvedValue(Response.json(body)),
    );
    await expect(client.getAutomation(base, program)).rejects.toMatchObject({
      reason: 'malformed',
    });
  });

  it.each([
    { version: 'other', ready: true, status: 'ready' },
    { version: 'version', ready: false, status: 'ready' },
    { version: 'version', ready: true, status: 'preparing' },
  ])(
    'rejects filler preparation without an exact ready immutable version: %j',
    async (body) => {
      const { client } = fixture(
        jest.fn().mockResolvedValue(Response.json(body)),
      );
      await expect(
        client.prepareFiller(base, program, 'version', []),
      ).rejects.toMatchObject({ reason: 'malformed' });
    },
  );

  it('stops automation with the requested sequence and no invented filler header', async () => {
    const { client, fetcher, metrics } = fixture(
      jest.fn().mockResolvedValue(Response.json({ lastSequence: 0 })),
    );
    await client.commandAutomation(base, program, 'stop', 0, 'stop-command');
    expect(fetcher.mock.calls[0][0]).toBe(
      `${base}/v1/programs/${program}/automation/stop`,
    );
    expect(fetcher.mock.calls[0][1].headers).toEqual({
      Accept: 'application/json',
      'Idempotency-Key': 'stop-command',
    });
    expect(metrics.snapshot().machineRequests['automation-stop:success']).toBe(
      1,
    );
  });

  it.each([
    { lastSequence: 3, readiness: true, filler: { activeVersion: 'version' } },
    { lastSequence: 4, readiness: false, filler: { activeVersion: 'version' } },
    { lastSequence: 4, readiness: true },
    {
      lastSequence: 4,
      readiness: true,
      filler: { activeVersion: 'different' },
    },
  ])(
    'requires acknowledgement of sequence, readiness and exact filler on start: %j',
    async (body) => {
      const { client } = fixture(
        jest.fn().mockResolvedValue(Response.json(body)),
      );
      await expect(
        client.commandAutomation(
          base,
          program,
          'start',
          4,
          'command',
          'version',
        ),
      ).rejects.toMatchObject({ reason: 'malformed' });
    },
  );

  it('does not report a rejected stop as a successful command', async () => {
    const { client, metrics } = fixture(
      jest.fn().mockResolvedValue(Response.json({ ok: false })),
    );
    await expect(client.stopInstants(base, program)).rejects.toMatchObject({
      reason: 'malformed',
    });
    expect(
      metrics.snapshot().machineRequests['instant-stop:success'],
    ).toBeUndefined();
  });

  it.each([
    new Response(null),
    new Response('not SSE', {
      headers: { 'content-type': 'application/json' },
    }),
  ])(
    'rejects event responses without a live SSE body and type',
    async (response) => {
      const { client } = fixture(jest.fn().mockResolvedValue(response));
      await expect(
        client.connectEvents(base, program, null, new AbortController().signal),
      ).rejects.toMatchObject({ reason: 'malformed' });
    },
  );

  it.each([
    new Response(null),
    new Response('not audio', { headers: { 'content-type': 'text/plain' } }),
  ])(
    'rejects output responses without a live audio body and cancels unusable data',
    async (response) => {
      const cancel = response.body && jest.spyOn(response.body, 'cancel');
      const { client } = fixture(jest.fn().mockResolvedValue(response));
      await expect(
        client.openOutput(base, program, new AbortController().signal),
      ).rejects.toMatchObject({ reason: 'malformed' });
      if (cancel) expect(cancel).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['timeout', 'caller'] as const)(
    'preserves %s cancellation and records only establishment timeouts as unavailable',
    async (source) => {
      jest.useFakeTimers();
      try {
        const abort = new AbortController();
        const reason = new Error('transport aborted');
        const { client, metrics } = fixture(
          jest.fn(
            (_url, init: RequestInit) =>
              new Promise((_resolve, reject) => {
                init.signal?.addEventListener('abort', () => reject(reason), {
                  once: true,
                });
              }),
          ),
        );
        const pending = client.openOutput(base, program, abort.signal);
        const rejected = expect(pending).rejects.toBe(reason);
        if (source === 'caller') abort.abort();
        else await jest.advanceTimersByTimeAsync(10_000);
        await rejected;
        expect(
          metrics.snapshot().machineRequests['output-monitor:unavailable'],
        ).toBe(source === 'timeout' ? 1 : undefined);
        expect(jest.getTimerCount()).toBe(0);
      } finally {
        jest.useRealTimers();
      }
    },
  );

  it('retries bounded network failures and records final unavailability with exponential backoff', async () => {
    const { client, metrics, fetcher } = fixture(
      jest.fn().mockRejectedValue(new TypeError('network unavailable')),
    );
    await expect(client.stopSong(base, program)).rejects.toMatchObject({
      reason: 'unavailable',
    });
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect((delay as jest.Mock).mock.calls.map((args) => args[0])).toEqual([
      100, 200,
    ]);
    expect(metrics.snapshot().machineRetries['song-stop']).toBe(2);
    expect(metrics.snapshot().machineRequests['song-stop:unavailable']).toBe(1);
  });

  it('retains cancellation during a retry backoff without reporting an upstream outage', async () => {
    const abort = new AbortController();
    const cancelled = new DOMException(
      'caller stopped monitoring',
      'AbortError',
    );
    const fetcher = jest
      .fn()
      .mockResolvedValueOnce(new Response('{}', { status: 503 }))
      .mockImplementationOnce((_url, init: RequestInit) => {
        expect(init.signal?.aborted).toBe(true);
        return Promise.reject(cancelled);
      });
    (delay as jest.Mock).mockImplementationOnce(() => {
      abort.abort();
      return Promise.reject(cancelled);
    });
    const { client, metrics } = fixture(fetcher);
    await expect(client.getMixer(base, program, abort.signal)).rejects.toBe(
      cancelled,
    );
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(metrics.snapshot().machineRetries['mixer-read']).toBe(1);
    expect(
      metrics.snapshot().machineRequests['mixer-read:unavailable'],
    ).toBeUndefined();
  });

  it('classifies a nonretrying transport failure as unavailable exactly once', async () => {
    const { client, fetcher, metrics } = fixture(
      jest.fn().mockRejectedValue(new Error('connection refused')),
    );
    await expect(
      client.getPlaybackState(base, program, new AbortController().signal),
    ).rejects.toMatchObject({ reason: 'unavailable' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(metrics.snapshot().machineRequests['state-read:unavailable']).toBe(
      1,
    );
    expect(delay).not.toHaveBeenCalled();
  });

  it('ignores response-body cleanup failure while retaining the server rejection', async () => {
    const body = new ReadableStream({
      cancel: () => Promise.reject(new Error('body transport already closed')),
    });
    const { client } = fixture(
      jest.fn().mockResolvedValue(new Response(body, { status: 403 })),
    );
    await expect(client.getPlaybackState(base, program)).rejects.toMatchObject({
      reason: 'unauthorized',
      status: 403,
    });
  });
});
