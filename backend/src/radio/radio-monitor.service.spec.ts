import { BadGatewayException, UnauthorizedException } from '@nestjs/common';
import { ReadableStream } from 'node:stream/web';
import { RadioMonitorService } from './radio-monitor.service';

function fixture() {
  const radio = {
    getRadioSettings: jest
      .fn()
      .mockResolvedValue({ palazzoUrl: 'https://radio.example' }),
  };
  const palazzo = { validateBaseUrl: jest.fn(), openOutput: jest.fn() };
  const metrics = { recordMonitor: jest.fn() };
  const service = new RadioMonitorService(
    radio as any,
    palazzo as any,
    metrics as any,
  );
  return { radio, palazzo, metrics, service };
}

function pendingAudio() {
  let controller: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
    },
  });
  return { body, close: () => controller.close() };
}

function closed(stream: NodeJS.ReadableStream) {
  return new Promise<void>((resolve) => stream.once('close', resolve));
}

describe('RadioMonitorService ticket and native stream lifecycle', () => {
  let now = 1000000;
  beforeEach(() => {
    now = 1000000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
  });
  afterEach(() => jest.restoreAllMocks());

  async function issue(f: ReturnType<typeof fixture>, programId = 'news') {
    const grant = await f.service.issue(programId);
    const url = new URL(grant.streamPath, 'http://localhost');
    return { ...grant, ticket: url.searchParams.get('ticket')! };
  }

  it('issues a bounded program ticket after validating the configured upstream without opening audio', async () => {
    const f = fixture();
    const grant = await issue(f, 'special/news');
    expect(grant.expiresInMs).toBe(60000);
    expect(grant.streamPath).toMatch(
      /^\/radio\/special%2Fnews\/monitor-audio\?ticket=/,
    );
    expect(grant.ticket).toMatch(/^[0-9a-f-]{36}$/);
    expect(f.palazzo.validateBaseUrl).toHaveBeenCalledWith(
      'https://radio.example',
    );
    expect(f.palazzo.openOutput).not.toHaveBeenCalled();
  });

  it('refuses missing radio settings and invalid upstream URLs before issuing a usable grant', async () => {
    const f = fixture();
    f.radio.getRadioSettings.mockResolvedValueOnce(null);
    await expect(f.service.issue('news')).rejects.toBeInstanceOf(
      BadGatewayException,
    );
    f.palazzo.validateBaseUrl.mockImplementation(() => {
      throw new Error('invalid upstream');
    });
    await expect(f.service.issue('news')).rejects.toThrow('invalid upstream');
    expect(f.palazzo.openOutput).not.toHaveBeenCalled();
  });

  it('rejects missing, expired and cross-program tickets before requesting upstream audio', async () => {
    const f = fixture();
    const signal = new AbortController().signal;
    await expect(
      f.service.open('news', 'unknown', signal),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    const cross = await issue(f);
    await expect(
      f.service.open('other', cross.ticket, signal),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    const expired = await issue(f);
    now += 60000;
    await expect(
      f.service.open('news', expired.ticket, signal),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(f.palazzo.openOutput).not.toHaveBeenCalled();
    expect(f.metrics.recordMonitor.mock.calls).toEqual([
      ['rejected'],
      ['rejected'],
      ['rejected'],
    ]);
  });

  it('retains an unexpired grant while issuing another program ticket', async () => {
    const f = fixture();
    const first = await issue(f);
    await issue(f, 'other');
    f.palazzo.openOutput.mockResolvedValue(new Response('audio'));
    const opened = await f.service.open(
      'news',
      first.ticket,
      new AbortController().signal,
    );
    const ended = closed(opened.stream);
    opened.stream.destroy();
    await ended;
    expect(f.metrics.recordMonitor.mock.calls).toEqual([
      ['opened'],
      ['closed'],
    ]);
  });

  it('prunes idle expired grants while retaining current tickets', async () => {
    const f = fixture();
    const stale = await issue(f);
    now += 60001;
    const current = await issue(f);
    await expect(
      f.service.open('news', stale.ticket, new AbortController().signal),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    f.palazzo.openOutput.mockResolvedValue(
      new Response('audio', { headers: { 'content-type': 'audio/mpeg' } }),
    );
    const opened = await f.service.open(
      'news',
      current.ticket,
      new AbortController().signal,
    );
    const ended = closed(opened.stream);
    const chunks: Buffer[] = [];
    for await (const chunk of opened.stream) chunks.push(chunk);
    await ended;
    expect(Buffer.concat(chunks).toString()).toBe('audio');
    expect(f.metrics.recordMonitor.mock.calls).toEqual([
      ['rejected'],
      ['opened'],
      ['closed'],
    ]);
  });

  it('forwards the exact program and abort signal and grants a thirty-second idle reconnect window after native stream closure', async () => {
    const f = fixture();
    const grant = await issue(f);
    const signal = new AbortController().signal;
    f.palazzo.openOutput.mockImplementation(
      async () =>
        new Response('mp3', { headers: { 'content-type': 'audio/mpeg' } }),
    );
    const result = await f.service.open('news', grant.ticket, signal);
    expect(result.type).toBe('audio/mpeg');
    expect(f.palazzo.openOutput).toHaveBeenCalledWith(
      'https://radio.example',
      'news',
      signal,
    );
    const ended = closed(result.stream);
    for await (const _ of result.stream) {
      /* consume native audio */
    }
    await ended;
    now += 29999;
    const reconnect = await f.service.open('news', grant.ticket, signal);
    const reclosed = closed(reconnect.stream);
    reconnect.stream.destroy();
    await reclosed;
    now += 30000;
    await expect(
      f.service.open('news', grant.ticket, signal),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('keeps an actively connected grant valid beyond its initial idle deadline and only starts expiry after its final connection closes', async () => {
    const f = fixture();
    const grant = await issue(f);
    const first = pendingAudio();
    const second = pendingAudio();
    f.palazzo.openOutput
      .mockResolvedValueOnce(new Response(first.body as any))
      .mockResolvedValueOnce(new Response(second.body as any));
    const a = await f.service.open(
      'news',
      grant.ticket,
      new AbortController().signal,
    );
    now += 120000;
    const b = await f.service.open(
      'news',
      grant.ticket,
      new AbortController().signal,
    );
    const aClosed = closed(a.stream);
    a.stream.destroy();
    await aClosed;
    now += 120000;
    const bClosed = closed(b.stream);
    b.stream.destroy();
    await bClosed;
    now += 30000;
    await expect(
      f.service.open('news', grant.ticket, new AbortController().signal),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(f.metrics.recordMonitor.mock.calls).toEqual([
      ['opened'],
      ['opened'],
      ['closed'],
      ['closed'],
      ['rejected'],
    ]);
  });

  it.each([false, true])(
    'reports a closed stream with aborted=%p without exposing the upstream failure',
    async (aborted) => {
      const f = fixture();
      const grant = await issue(f);
      const request = new AbortController();
      const audio = pendingAudio();
      f.palazzo.openOutput.mockResolvedValue(new Response(audio.body as any));
      const result = await f.service.open('news', grant.ticket, request.signal);
      if (aborted) request.abort();
      const ended = closed(result.stream);
      result.stream.destroy(new Error('fictional upstream stream failure'));
      await ended;
      expect(f.metrics.recordMonitor).toHaveBeenLastCalledWith(
        aborted ? 'aborted' : 'failure',
      );
    },
  );

  it.each(['settings', 'upstream', 'body', 'aborted'] as const)(
    'releases a failed %s connection and preserves the bounded reconnect window',
    async (failure) => {
      const f = fixture();
      const grant = await issue(f);
      const request = new AbortController();
      if (failure === 'settings')
        f.radio.getRadioSettings.mockResolvedValueOnce(null);
      else if (failure === 'body')
        f.palazzo.openOutput.mockResolvedValueOnce(new Response(null));
      else
        f.palazzo.openOutput.mockRejectedValueOnce(
          new Error('private upstream diagnostic'),
        );
      if (failure === 'aborted') request.abort();
      await expect(
        f.service.open('news', grant.ticket, request.signal),
      ).rejects.toThrow('Program audio is unavailable');
      expect(f.metrics.recordMonitor).toHaveBeenLastCalledWith(
        failure === 'aborted' ? 'aborted' : 'failure',
      );
      now += 30000;
      await expect(
        f.service.open('news', grant.ticket, new AbortController().signal),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    },
  );
});
