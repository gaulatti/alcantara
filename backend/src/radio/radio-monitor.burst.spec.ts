import { ReadableStream } from 'node:stream/web';
import { RadioMonitorService, skipOpeningBurst } from './radio-monitor.service';

// A return feed starts close to live: Icecast's opening burst (about 16 s of buffered audio) is dropped, and the
// audio that follows passes unchanged. The operator's monitor keeps the whole stream.

function collect(stream: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    stream.on('data', (chunk: Buffer) => parts.push(chunk));
    stream.once('end', () => resolve(Buffer.concat(parts).toString()));
    stream.once('error', reject);
  });
}

describe('skipOpeningBurst', () => {
  it('drops what arrives in the first 750 ms after the first chunk and passes everything after', async () => {
    let now = 0;
    const transform = skipOpeningBurst(() => now);
    const out = collect(transform);
    transform.write(Buffer.from('burst-1|'));
    now = 749;
    transform.write(Buffer.from('burst-2|'));
    now = 750;
    transform.write(Buffer.from('live-1|'));
    now = 5_000;
    transform.end(Buffer.from('live-2'));
    await expect(out).resolves.toBe('live-1|live-2');
  });

  it('uses the wall clock by default', async () => {
    const transform = skipOpeningBurst();
    const out = collect(transform);
    transform.end(Buffer.from('burst'));
    await expect(out).resolves.toBe('');
  });
});

describe('RadioMonitorService with a return grant', () => {
  function fixture(body: ReadableStream<Uint8Array>) {
    const radio = {
      getRadioSettings: jest
        .fn()
        .mockResolvedValue({ palazzoUrl: 'https://radio.example' }),
    };
    const palazzo = {
      validateBaseUrl: jest.fn(),
      openOutput: jest.fn().mockResolvedValue({
        body,
        headers: new Headers({ 'content-type': 'audio/mpeg' }),
      }),
    };
    const metrics = { recordMonitor: jest.fn() };
    const service = new RadioMonitorService(
      radio as never,
      palazzo as never,
      metrics as never,
    );
    return { service, metrics };
  }
  const ticketOf = (path: string) =>
    new URL(path, 'http://localhost').searchParams.get('ticket')!;

  it('skips the burst only for a return grant, and stops reading Palazzo when the listener leaves', async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start: (value) => {
        controller = value;
      },
      cancel: () => {
        cancelled = true;
      },
    });
    const f = fixture(body);
    const grant = await f.service.issue('modoitaliano.fm', { skipBurst: true });
    const output = await f.service.open(
      'modoitaliano.fm',
      ticketOf(grant.streamPath),
      new AbortController().signal,
    );
    expect(output.type).toBe('audio/mpeg');
    const received: string[] = [];
    output.stream.on('data', (chunk: Buffer) =>
      received.push(chunk.toString()),
    );
    controller.enqueue(new TextEncoder().encode('burst'));
    await new Promise((resolve) => setTimeout(resolve, 800));
    controller.enqueue(new TextEncoder().encode('live'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(received.join('')).toBe('live');
    const closed = new Promise((resolve) =>
      output.stream.once('close', resolve),
    );
    output.stream.destroy();
    await closed;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(cancelled).toBe(true);
    expect(f.metrics.recordMonitor).toHaveBeenCalledWith('opened');
  });

  it('passes a failure of the Palazzo stream on to the listener', async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start: (value) => {
        controller = value;
      },
    });
    const f = fixture(body);
    const grant = await f.service.issue('modoitaliano.fm', { skipBurst: true });
    const output = await f.service.open(
      'modoitaliano.fm',
      ticketOf(grant.streamPath),
      new AbortController().signal,
    );
    const failed = new Promise<Error>((resolve) =>
      output.stream.once('error', resolve),
    );
    const closed = new Promise((resolve) =>
      output.stream.once('close', resolve),
    );
    // The listener reads, as the HTTP reply does.
    output.stream.resume();
    controller.error(new Error('upstream dropped'));
    await expect(failed).resolves.toBeInstanceOf(Error);
    await closed;
    expect(f.metrics.recordMonitor).toHaveBeenCalledWith('failure');
  });

  it('keeps the whole stream for the operator monitor', async () => {
    const body = new ReadableStream<Uint8Array>({
      start: (value) => {
        value.enqueue(new TextEncoder().encode('everything'));
        value.close();
      },
    });
    const f = fixture(body);
    const grant = await f.service.issue('modoitaliano.fm');
    const output = await f.service.open(
      'modoitaliano.fm',
      ticketOf(grant.streamPath),
      new AbortController().signal,
    );
    await expect(collect(output.stream)).resolves.toBe('everything');
  });
});
