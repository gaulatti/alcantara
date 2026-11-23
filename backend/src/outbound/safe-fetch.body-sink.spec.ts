import { EventEmitter } from 'node:events';
import type * as http from 'node:http';
import { Readable, Writable } from 'node:stream';
import { isAudioMediaType } from './media-types';
import {
  OutboundRefusal,
  safeFetch,
  type OutboundFetchResult,
  type SafeFetchDeps,
  type SafeFetchOptions,
} from './safe-fetch';
import { scriptedTransport } from './safe-fetch.testing';

// A caller may stream the body into a writable instead of holding it in
// memory; the byte cap, the deadline and the refusals stay the same.

const names = { 'media.example.com': ['93.184.216.34'] };
const url = 'https://media.example.com/a.mp3';

function collector(options: ConstructorParameters<typeof Writable>[0] = {}) {
  const chunks: Buffer[] = [];
  const sink = new Writable({
    write(chunk: Buffer, _encoding, done) {
      chunks.push(chunk);
      done();
    },
    ...options,
  });
  return { sink, written: () => Buffer.concat(chunks) };
}

function options(
  bodySink: Writable,
  extra: Partial<SafeFetchOptions> = {},
): SafeFetchOptions {
  return {
    path: 'media_analysis',
    maxBytes: 1024,
    timeoutMs: 1000,
    maxRedirects: 0,
    allowContentType: isAudioMediaType,
    bodySink,
    ...extra,
  };
}

function audio(body: Buffer[]) {
  return {
    [`media.example.com/a.mp3`]: {
      status: 200,
      headers: { 'content-type': 'audio/mpeg' },
      body,
    },
  };
}

async function refusal(work: Promise<unknown>) {
  const error = await work.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(OutboundRefusal);
  return (error as OutboundRefusal).reason;
}

describe('outbound-request policy, streaming body', () => {
  it('writes the body into the sink and returns no body in memory', async () => {
    const transport = scriptedTransport(
      names,
      audio([Buffer.from('ID3'), Buffer.from('fake')]),
    );
    const recorded: OutboundFetchResult[] = [];
    const { sink, written } = collector();
    const response = await safeFetch(url, options(sink), {
      ...transport,
      record: (_path, result) => recorded.push(result),
    });
    expect(written().toString()).toBe('ID3fake');
    expect(response.body.byteLength).toBe(0);
    expect(response.contentLength).toBe(7);
    expect(response.contentType).toBe('audio/mpeg');
    expect(recorded).toEqual(['ok']);
    expect(sink.writableFinished).toBe(true);
    expect(transport.sent[0].connectedTo).toBe('93.184.216.34');
  });

  it('waits for a slow sink to drain before reading on', async () => {
    const parts = Array.from({ length: 6 }, (_, i) => Buffer.from(`part${i};`));
    const received: Buffer[] = [];
    const { sink, written } = collector({
      highWaterMark: 1,
      write(chunk: Buffer, _encoding, done) {
        received.push(chunk);
        setImmediate(done);
      },
    });
    const response = await safeFetch(
      url,
      options(sink),
      scriptedTransport(names, audio(parts)),
    );
    expect(Buffer.concat(received).toString()).toBe(
      Buffer.concat(parts).toString(),
    );
    expect(written().byteLength).toBe(0);
    expect(response.contentLength).toBe(Buffer.concat(parts).byteLength);
  });

  it('refuses a streamed body once it passes the cap, keeping only what fit', async () => {
    const { sink, written } = collector();
    const reason = await refusal(
      safeFetch(
        url,
        options(sink, { maxBytes: 4 }),
        scriptedTransport(
          names,
          audio([Buffer.from('abc'), Buffer.from('def')]),
        ),
      ),
    );
    expect(reason).toBe('too_large');
    expect(written().toString()).toBe('abc');
  });

  it('reports a sink that fails while writing or while finishing as a network failure', async () => {
    const failing = new Writable({
      write(_chunk, _encoding, done) {
        done(new Error('disk full'));
      },
    });
    expect(
      await refusal(
        safeFetch(
          url,
          options(failing),
          scriptedTransport(names, audio([Buffer.from('abc')])),
        ),
      ),
    ).toBe('network');

    const unfinished = new Writable({
      write(_chunk, _encoding, done) {
        done();
      },
      final(done) {
        done(new Error('close failed'));
      },
    });
    unfinished.on('error', () => undefined);
    expect(
      await refusal(
        safeFetch(
          url,
          options(unfinished),
          scriptedTransport(names, audio([Buffer.from('abc')])),
        ),
      ),
    ).toBe('network');
  });

  it('reports a body that breaks off as a network failure', async () => {
    const request: SafeFetchDeps['request'] = () => {
      const req = new EventEmitter() as EventEmitter & {
        write: () => boolean;
        end: () => void;
        destroy: () => void;
      };
      req.write = () => true;
      req.destroy = () => undefined;
      req.end = () => {
        const response = new Readable({
          read() {
            this.push(Buffer.from('abc'));
            this.destroy(new Error('ECONNRESET'));
          },
        }) as Readable & { statusCode: number; headers: object };
        response.statusCode = 200;
        response.headers = { 'content-type': 'audio/mpeg' };
        req.emit('response', response);
      };
      return req as unknown as http.ClientRequest;
    };
    const { sink } = collector();
    expect(
      await refusal(
        safeFetch(url, options(sink), {
          resolve: () =>
            Promise.resolve([{ address: '93.184.216.34', family: 4 }]),
          request,
        }),
      ),
    ).toBe('network');
  });
});
