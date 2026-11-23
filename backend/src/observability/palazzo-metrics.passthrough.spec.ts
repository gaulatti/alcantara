import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  PALAZZO_METRICS_MAX_BYTES,
  PALAZZO_METRICS_TIMEOUT_MS,
  PalazzoMetricsPassthrough,
} from './palazzo-metrics.passthrough';
import { ManagedMetricsService } from './managed-metrics.service';

function build(
  fetchImpl: jest.Mock,
  urls: string | null | undefined = 'http://palazzo:3100',
) {
  const managed = new ManagedMetricsService();
  const config = { get: jest.fn().mockReturnValue(urls ?? undefined) };
  const passthrough = new PalazzoMetricsPassthrough(
    config as unknown as ConfigService,
    managed,
    fetchImpl as unknown as typeof fetch,
  );
  return { passthrough, managed };
}

function counter(output: string, result: string): number {
  const line = output
    .split('\n')
    .find((l) =>
      l.startsWith(
        `alcantara_palazzo_metrics_scrape_total{result="${result}"}`,
      ),
    );
  return Number(line?.split(' ').pop());
}

describe('PalazzoMetricsPassthrough', () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('returns the body and sends a fixed, redirect-refusing, credential-free GET', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValue(new Response('palazzo_up 1\n', { status: 200 }));
    const { passthrough, managed } = build(fetchImpl);
    await expect(passthrough.fetch()).resolves.toBe('palazzo_up 1\n');
    const [url, init] = fetchImpl.mock.calls[0] as [
      string,
      RequestInit & { headers: Record<string, string> },
    ];
    expect(url).toBe('http://palazzo:3100/metrics');
    expect(init.redirect).toBe('manual');
    expect(init.method).toBe('GET');
    expect(Object.keys(init.headers)).toEqual(['Accept']);

    const output = await managed.render('');
    expect(counter(output, 'ok')).toBe(1);
    for (const r of ['unavailable', 'timeout', 'too_large', 'error'])
      expect(counter(output, r)).toBe(0);
    expect(output).toContain(
      'alcantara_palazzo_metrics_scrape_duration_seconds_count 1',
    );
    expect(output).toContain(
      'alcantara_palazzo_metrics_scrape_duration_seconds_bucket{le="2.5"} 1',
    );
  });

  it('treats an empty body as an empty success', async () => {
    const response = new Response(null, { status: 200 });
    const { passthrough } = build(jest.fn().mockResolvedValue(response));
    await expect(passthrough.fetch()).resolves.toBe('');
  });

  it('counts a refused connection as unavailable', async () => {
    const { passthrough, managed } = build(
      jest.fn().mockRejectedValue(new TypeError('fetch failed')),
    );
    await expect(passthrough.fetch()).resolves.toBeNull();
    expect(counter(await managed.render(''), 'unavailable')).toBe(1);
  });

  it('times out within the 2 second budget', async () => {
    jest.useFakeTimers();
    const fetchImpl = jest.fn(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal!.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
        }),
    );
    const { passthrough, managed } = build(fetchImpl as unknown as jest.Mock);
    const pending = passthrough.fetch();
    await jest.advanceTimersByTimeAsync(PALAZZO_METRICS_TIMEOUT_MS - 1);
    let settled = false;
    void pending.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toBeNull();
    expect(PALAZZO_METRICS_TIMEOUT_MS).toBe(2000);
    expect(counter(await managed.render(''), 'timeout')).toBe(1);
  });

  it('times out while a slow body is being read', async () => {
    jest.useFakeTimers();
    const fetchImpl = jest.fn((_url: string, init: RequestInit) => {
      const body = new ReadableStream({
        start(streamController) {
          init.signal!.addEventListener('abort', () =>
            streamController.error(new DOMException('aborted', 'AbortError')),
          );
        },
      });
      return Promise.resolve(new Response(body, { status: 200 }));
    });
    const { passthrough } = build(fetchImpl as unknown as jest.Mock);
    const pending = passthrough.fetch();
    await jest.advanceTimersByTimeAsync(PALAZZO_METRICS_TIMEOUT_MS);
    await expect(pending).resolves.toBeNull();
  });

  it.each([500, 404, 302])('answers null for status %d', async (status) => {
    const { passthrough, managed } = build(
      jest.fn().mockResolvedValue(
        new Response('x', {
          status,
          headers: status === 302 ? { location: 'http://evil/' } : {},
        }),
      ),
    );
    await expect(passthrough.fetch()).resolves.toBeNull();
    expect(counter(await managed.render(''), 'error')).toBe(1);
  });

  it('answers error for a non-2xx without a body', async () => {
    const { passthrough } = build(
      jest.fn().mockResolvedValue(new Response(null, { status: 503 })),
    );
    await expect(passthrough.fetch()).resolves.toBeNull();
  });

  it('rejects an oversized declared Content-Length', async () => {
    const { passthrough, managed } = build(
      jest.fn().mockResolvedValue(
        new Response('x', {
          status: 200,
          headers: { 'content-length': String(PALAZZO_METRICS_MAX_BYTES + 1) },
        }),
      ),
    );
    await expect(passthrough.fetch()).resolves.toBeNull();
    expect(counter(await managed.render(''), 'too_large')).toBe(1);
  });

  it('rejects a streamed body that exceeds the cap', async () => {
    const chunk = new Uint8Array(1024 * 1024);
    let sent = 0;
    const body = new ReadableStream({
      pull(streamController) {
        sent += 1;
        streamController.enqueue(chunk);
        if (sent > 10) streamController.close();
      },
    });
    const { passthrough, managed } = build(
      jest.fn().mockResolvedValue(new Response(body, { status: 200 })),
    );
    await expect(passthrough.fetch()).resolves.toBeNull();
    expect(counter(await managed.render(''), 'too_large')).toBe(1);
  });

  it('accepts a body of exactly the cap', async () => {
    const { passthrough } = build(
      jest
        .fn()
        .mockResolvedValue(
          new Response('a'.repeat(PALAZZO_METRICS_MAX_BYTES), { status: 200 }),
        ),
    );
    await expect(passthrough.fetch()).resolves.toHaveLength(
      PALAZZO_METRICS_MAX_BYTES,
    );
  });

  it('counts a body read failure as error', async () => {
    const body = new ReadableStream({
      start(streamController) {
        streamController.error(new Error('reset'));
      },
    });
    const { passthrough, managed } = build(
      jest.fn().mockResolvedValue(new Response(body, { status: 200 })),
    );
    await expect(passthrough.fetch()).resolves.toBeNull();
    expect(counter(await managed.render(''), 'error')).toBe(1);
  });

  it.each([null, '', 'not a url', 'http://a:1,http://b:2', 'http://a:1/x'])(
    'fails closed and warns once when PALAZZO_ALLOWED_URLS is %p',
    async (urls) => {
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      const fetchImpl = jest.fn();
      const { passthrough, managed } = build(fetchImpl, urls);
      await expect(passthrough.fetch()).resolves.toBeNull();
      await expect(passthrough.fetch()).resolves.toBeNull();
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).not.toContain('http://');
      expect(counter(await managed.render(''), 'unavailable')).toBe(2);
    },
  );

  it('uses the global fetch when none is injected', async () => {
    const spy = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('ok 1\n', { status: 200 }));
    const passthrough = new PalazzoMetricsPassthrough(
      { get: () => 'http://palazzo:3100' } as unknown as ConfigService,
      new ManagedMetricsService(),
    );
    await expect(passthrough.fetch()).resolves.toBe('ok 1\n');
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
