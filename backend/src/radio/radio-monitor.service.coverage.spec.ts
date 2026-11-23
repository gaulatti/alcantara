import { BadGatewayException, UnauthorizedException } from '@nestjs/common';
import { RadioMonitorService } from './radio-monitor.service';

function webBody() {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([1, 2, 3]));
    },
  });
}

function build() {
  const radio = {
    getRadioSettings: jest
      .fn()
      .mockResolvedValue({ palazzoUrl: 'https://palazzo.test' }),
  };
  const palazzo = {
    validateBaseUrl: jest.fn(),
    openOutput: jest.fn().mockImplementation(
      async () =>
        new Response(webBody(), {
          headers: { 'content-type': 'audio/mpeg' },
        }),
    ),
  };
  const metrics = { recordMonitor: jest.fn() };
  const service = new RadioMonitorService(
    radio as any,
    palazzo as any,
    metrics as any,
  );
  return { service, radio, palazzo, metrics };
}

const ticketOf = (path: string) =>
  new URL(path, 'http://x.test').searchParams.get('ticket')!;

describe('RadioMonitorService coverage', () => {
  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    jest.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  describe('issue', () => {
    it('rejects when radio settings are unavailable', async () => {
      const { service, radio, palazzo } = build();
      radio.getRadioSettings.mockResolvedValue(null);
      await expect(service.issue('main')).rejects.toThrow(
        new BadGatewayException('Radio connection is unavailable'),
      );
      expect(palazzo.validateBaseUrl).not.toHaveBeenCalled();
    });

    it('validates the palazzo url and returns an encoded stream path', async () => {
      const { service, palazzo } = build();
      const result = await service.issue('a b/c');
      expect(palazzo.validateBaseUrl).toHaveBeenCalledWith(
        'https://palazzo.test',
      );
      expect(result.expiresInMs).toBe(60_000);
      expect(result.streamPath).toMatch(
        /^\/radio\/a%20b%2Fc\/monitor-audio\?ticket=[0-9a-f-]{36}$/,
      );
    });

    it('drops expired idle grants but keeps live and connected ones', async () => {
      const { service, metrics } = build();
      const stale = ticketOf((await service.issue('main')).streamPath);
      const connected = ticketOf((await service.issue('main')).streamPath);
      const connection = await service.open(
        'main',
        connected,
        new AbortController().signal,
      );
      jest.setSystemTime(Date.now() + 61_000);
      const fresh = ticketOf((await service.issue('main')).streamPath);

      // stale grant was purged: it is now rejected as unknown
      await expect(
        service.open('main', stale, new AbortController().signal),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      // connected grant (expired by time but with a live connection) survives
      const second = await service.open(
        'main',
        connected,
        new AbortController().signal,
      );
      // fresh grant (not expired) survives
      const third = await service.open(
        'main',
        fresh,
        new AbortController().signal,
      );
      expect(metrics.recordMonitor).toHaveBeenCalledWith('rejected');
      for (const o of [connection, second, third]) o.stream.destroy();
    });
  });

  describe('open', () => {
    it('rejects an unknown ticket', async () => {
      const { service, metrics } = build();
      await expect(
        service.open('main', 'nope', new AbortController().signal),
      ).rejects.toThrow(
        new UnauthorizedException('Valid monitor ticket required'),
      );
      expect(metrics.recordMonitor).toHaveBeenCalledWith('rejected');
    });

    it('rejects an expired idle ticket', async () => {
      const { service, metrics } = build();
      const ticket = ticketOf((await service.issue('main')).streamPath);
      jest.setSystemTime(Date.now() + 60_000);
      await expect(
        service.open('main', ticket, new AbortController().signal),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(metrics.recordMonitor).toHaveBeenCalledWith('rejected');
    });

    it('rejects and discards a ticket used for another program', async () => {
      const { service } = build();
      const ticket = ticketOf((await service.issue('main')).streamPath);
      await expect(
        service.open('other', ticket, new AbortController().signal),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      await expect(
        service.open('main', ticket, new AbortController().signal),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('streams the output with its content type and reports closed', async () => {
      const { service, palazzo, metrics } = build();
      const ticket = ticketOf((await service.issue('main')).streamPath);
      const signal = new AbortController().signal;
      const out = await service.open('main', ticket, signal);
      expect(out.type).toBe('audio/mpeg');
      expect(palazzo.openOutput).toHaveBeenCalledWith(
        'https://palazzo.test',
        'main',
        signal,
      );
      expect(metrics.recordMonitor).toHaveBeenCalledWith('opened');
      const closed = new Promise((resolve) =>
        out.stream.once('close', resolve),
      );
      out.stream.destroy();
      await closed;
      expect(metrics.recordMonitor).toHaveBeenLastCalledWith('closed');
    });

    it('reports failure when the stream errors before closing', async () => {
      const { service, metrics } = build();
      const ticket = ticketOf((await service.issue('main')).streamPath);
      const out = await service.open(
        'main',
        ticket,
        new AbortController().signal,
      );
      const closed = new Promise((resolve) =>
        out.stream.once('close', resolve),
      );
      out.stream.on('error', () => undefined);
      out.stream.destroy(new Error('broken pipe'));
      await closed;
      expect(metrics.recordMonitor).toHaveBeenLastCalledWith('failure');
    });

    it('reports aborted when the signal aborted before close', async () => {
      const { service, metrics } = build();
      const ticket = ticketOf((await service.issue('main')).streamPath);
      const abort = new AbortController();
      const out = await service.open('main', ticket, abort.signal);
      const closed = new Promise((resolve) =>
        out.stream.once('close', resolve),
      );
      abort.abort();
      out.stream.destroy();
      await closed;
      expect(metrics.recordMonitor).toHaveBeenLastCalledWith('aborted');
    });

    it('keeps the grant alive for reconnects and only re-arms the idle window when the last connection closes', async () => {
      const { service } = build();
      const ticket = ticketOf((await service.issue('main')).streamPath);
      const first = await service.open(
        'main',
        ticket,
        new AbortController().signal,
      );
      const second = await service.open(
        'main',
        ticket,
        new AbortController().signal,
      );
      const firstClosed = new Promise((r) => first.stream.once('close', r));
      first.stream.destroy();
      await firstClosed;
      // still one live connection: ticket must remain usable long after expiry
      jest.setSystemTime(Date.now() + 10 * 60_000);
      const third = await service.open(
        'main',
        ticket,
        new AbortController().signal,
      );
      const secondClosed = new Promise((r) => second.stream.once('close', r));
      second.stream.destroy();
      await secondClosed;
      const thirdClosed = new Promise((r) => third.stream.once('close', r));
      third.stream.destroy();
      await thirdClosed;
      // last connection closed: 30s reconnect window, then expired
      jest.setSystemTime(Date.now() + 29_000);
      const again = await service.open(
        'main',
        ticket,
        new AbortController().signal,
      );
      const againClosed = new Promise((r) => again.stream.once('close', r));
      again.stream.destroy();
      await againClosed;
      jest.setSystemTime(Date.now() + 30_000);
      await expect(
        service.open('main', ticket, new AbortController().signal),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('maps missing settings to bad gateway and releases the connection', async () => {
      const { service, radio, metrics } = build();
      const ticket = ticketOf((await service.issue('main')).streamPath);
      radio.getRadioSettings.mockResolvedValue(null);
      await expect(
        service.open('main', ticket, new AbortController().signal),
      ).rejects.toThrow(
        new BadGatewayException('Program audio is unavailable'),
      );
      expect(metrics.recordMonitor).toHaveBeenLastCalledWith('failure');
    });

    it('maps upstream failures while aborted to aborted metric', async () => {
      const { service, palazzo, metrics } = build();
      const ticket = ticketOf((await service.issue('main')).streamPath);
      palazzo.openOutput.mockRejectedValue(new Error('upstream'));
      const abort = new AbortController();
      abort.abort();
      await expect(
        service.open('main', ticket, abort.signal),
      ).rejects.toBeInstanceOf(BadGatewayException);
      expect(metrics.recordMonitor).toHaveBeenLastCalledWith('aborted');
    });
  });
});
