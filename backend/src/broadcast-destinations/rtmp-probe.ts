import { randomBytes } from 'node:crypto';
import * as net from 'node:net';
import * as tls from 'node:tls';

/**
 * An RTMP connect and publish handshake that sends no media (gaulatti/alcantara#384): it tells whether the ingest
 * accepts the saved address and stream key. Only the commands of the handshake are written; the key appears in the
 * publish command and nowhere in the answer.
 */
export type RtmpProbeResult =
  | { result: 'accepted' }
  | { result: 'refused'; message: string }
  | { result: 'unreachable'; message: string };

export interface RtmpTarget {
  scheme: 'rtmp' | 'rtmps';
  host: string;
  port?: number;
  application: string;
  streamKey: string;
  /** The checked address the connection must use; `host` is still sent for TLS and the tcUrl. */
  address: string;
}

export type RtmpConnector = (target: {
  scheme: 'rtmp' | 'rtmps';
  host: string;
  address: string;
  port: number;
}) => net.Socket;

export const connectRtmp: RtmpConnector = ({ scheme, host, address, port }) =>
  scheme === 'rtmps'
    ? tls.connect({
        host: address,
        port,
        servername: net.isIP(host) ? undefined : host,
      })
    : net.connect({ host: address, port });

const HANDSHAKE_SIZE = 1536;
const CHUNK_SIZE = 128;
const MAX_INBOUND = 256 * 1024;

type Amf = number | boolean | string | null | { [key: string]: Amf };

export function amfEncode(values: Amf[]): Buffer {
  const parts: Buffer[] = [];
  const text = (value: string) => {
    const bytes = Buffer.from(value, 'utf8');
    const head = Buffer.alloc(2);
    head.writeUInt16BE(bytes.length);
    parts.push(head, bytes);
  };
  const write = (value: Amf) => {
    if (typeof value === 'number') {
      const out = Buffer.alloc(9);
      out.writeDoubleBE(value, 1);
      parts.push(out);
    } else if (typeof value === 'boolean') {
      parts.push(Buffer.from([1, value ? 1 : 0]));
    } else if (typeof value === 'string') {
      parts.push(Buffer.from([2]));
      text(value);
    } else if (value === null) {
      parts.push(Buffer.from([5]));
    } else {
      parts.push(Buffer.from([3]));
      for (const [key, item] of Object.entries(value)) {
        text(key);
        write(item);
      }
      parts.push(Buffer.from([0, 0, 9]));
    }
  };
  values.forEach(write);
  return Buffer.concat(parts);
}

export function amfDecode(data: Buffer): unknown[] {
  let at = 0;
  const text = () => {
    const length = data.readUInt16BE(at);
    at += 2;
    const value = data.toString('utf8', at, at + length);
    at += length;
    return value;
  };
  const read = (): unknown => {
    const type = data[at++];
    if (type === 0) {
      const value = data.readDoubleBE(at);
      at += 8;
      return value;
    }
    if (type === 1) return data[at++] !== 0;
    if (type === 2) return text();
    if (type === 3 || type === 8) {
      if (type === 8) at += 4;
      const object: Record<string, unknown> = {};
      for (;;) {
        const key = text();
        if (data[at] === 9 && key === '') {
          at += 1;
          return object;
        }
        object[key] = read();
      }
    }
    if (type === 5 || type === 6) return null;
    throw new Error('unsupported AMF value');
  };
  const values: unknown[] = [];
  while (at < data.length) values.push(read());
  return values;
}

/** One command message split into chunks of the default size, on chunk stream 3. */
export function chunkCommand(payload: Buffer, streamId: number): Buffer {
  const header = Buffer.alloc(12);
  header[0] = 3;
  header.writeUIntBE(payload.length, 4, 3);
  header[7] = 20;
  header.writeUInt32LE(streamId, 8);
  const parts: Buffer[] = [header, payload.subarray(0, CHUNK_SIZE)];
  for (let at = CHUNK_SIZE; at < payload.length; at += CHUNK_SIZE)
    parts.push(Buffer.from([0xc3]), payload.subarray(at, at + CHUNK_SIZE));
  return Buffer.concat(parts);
}

/** Reassembles the server's chunks into whole messages. */
export class ChunkReader {
  private buffer = Buffer.alloc(0);
  private chunkSize = CHUNK_SIZE;
  private readonly streams = new Map<
    number,
    { length: number; type: number; extended: boolean; parts: Buffer[] }
  >();

  push(data: Buffer): Array<{ type: number; payload: Buffer }> {
    this.buffer = Buffer.concat([this.buffer, data]);
    const messages: Array<{ type: number; payload: Buffer }> = [];
    for (;;) {
      const message = this.chunk();
      if (message === undefined) return messages;
      if (!message) continue;
      if (message.type === 1) {
        this.chunkSize = message.payload.readUInt32BE(0) & 0x7fffffff;
        if (this.chunkSize < 1) throw new Error('bad chunk size');
      } else messages.push(message);
    }
  }

  // undefined: more bytes needed; null: a chunk was read but its message is not complete.
  private chunk(): { type: number; payload: Buffer } | null | undefined {
    const buffer = this.buffer;
    if (!buffer.length) return undefined;
    const format = buffer[0] >> 6;
    let id = buffer[0] & 0x3f;
    let at = 1;
    if (id === 0) {
      if (buffer.length < 2) return undefined;
      id = 64 + buffer[at++];
    } else if (id === 1) {
      if (buffer.length < 3) return undefined;
      id = 64 + buffer[1] + buffer[2] * 256;
      at = 3;
    }
    const previous = this.streams.get(id);
    const headerSize = [11, 7, 3, 0][format];
    if (buffer.length < at + headerSize) return undefined;
    let length = previous?.length ?? 0;
    let type = previous?.type ?? 0;
    let extended = previous?.extended ?? false;
    if (format < 3) extended = buffer.readUIntBE(at, 3) === 0xffffff;
    if (format < 2) {
      length = buffer.readUIntBE(at + 3, 3);
      type = buffer[at + 6];
    }
    at += headerSize;
    if (extended) at += 4;
    if (length > MAX_INBOUND) throw new Error('message too large');
    const parts = previous?.parts ?? [];
    const received = parts.reduce((sum, part) => sum + part.length, 0);
    const take = Math.min(this.chunkSize, length - received);
    if (buffer.length < at + take) return undefined;
    parts.push(buffer.subarray(at, at + take));
    this.buffer = buffer.subarray(at + take);
    if (received + take < length) {
      this.streams.set(id, { length, type, extended, parts });
      return null;
    }
    this.streams.set(id, { length, type, extended, parts: [] });
    return { type, payload: Buffer.concat(parts) };
  }
}

/** The server's own words, without the key and cut short. */
export function safeMessage(text: unknown, streamKey: string): string {
  const raw = typeof text === 'string' && text ? text : 'The server refused';
  return raw
    .split(streamKey)
    .join('[key]')
    .split(encodeURIComponent(streamKey))
    .join('[key]')
    .slice(0, 200);
}

export function probeRtmp(
  target: RtmpTarget,
  timeoutMs: number,
  connect: RtmpConnector = connectRtmp,
): Promise<RtmpProbeResult> {
  const { scheme, host, application, streamKey, address } = target;
  const port = target.port ?? (scheme === 'rtmps' ? 443 : 1935);
  const authority = net.isIP(host) === 6 ? `[${host}]` : host;
  const tcUrl = `${scheme}://${authority}:${port}/${application}`;
  return new Promise((resolve) => {
    let done = false;
    let received = Buffer.alloc(0);
    let handshaken = false;
    let reached = false;
    const reader = new ChunkReader();
    const socket = connect({ scheme, host, address, port });
    const finish = (result: RtmpProbeResult) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    const failed = (message: string) =>
      finish(
        reached
          ? { result: 'refused', message }
          : { result: 'unreachable', message },
      );
    const timer = setTimeout(
      () => failed('The server did not answer in time'),
      timeoutMs,
    );
    const send = (values: Amf[], streamId = 0) =>
      socket.write(chunkCommand(amfEncode(values), streamId));
    const hello = () => {
      const c1 = Buffer.concat([
        Buffer.alloc(8),
        randomBytes(HANDSHAKE_SIZE - 8),
      ]);
      socket.write(Buffer.concat([Buffer.from([3]), c1]));
    };
    socket.on(scheme === 'rtmps' ? 'secureConnect' : 'connect', hello);
    socket.on('error', () => failed('The connection failed'));
    socket.on('close', () => failed('The server closed the connection'));

    const command = (payload: Buffer) => {
      const [name, transaction, , info] = amfDecode(payload) as [
        string,
        number,
        unknown,
        unknown,
      ];
      const details = (info && typeof info === 'object' ? info : {}) as Record<
        string,
        unknown
      >;
      const reason = () =>
        safeMessage(details.description ?? details.code, streamKey);
      if (name === '_error') {
        // Servers answer the optional releaseStream and FCPublish with _error too; only connect and createStream
        // decide.
        if (transaction === 1 || transaction === 4)
          finish({ result: 'refused', message: reason() });
      } else if (name === '_result' && transaction === 1) {
        send(['releaseStream', 2, null, streamKey]);
        send(['FCPublish', 3, null, streamKey]);
        send(['createStream', 4, null]);
      } else if (name === '_result' && transaction === 4) {
        const streamId = typeof info === 'number' ? info : 1;
        send(['publish', 0, null, streamKey, 'live'], streamId);
      } else if (name === 'onStatus') {
        if (details.code === 'NetStream.Publish.Start') {
          send(['FCUnpublish', 5, null, streamKey]);
          finish({ result: 'accepted' });
        } else if (details.level === 'error') {
          finish({ result: 'refused', message: reason() });
        }
      } else if (name === 'close') {
        finish({ result: 'refused', message: 'The server closed the stream' });
      }
    };

    socket.on('data', (data: Buffer) => {
      try {
        if (!handshaken) {
          received = Buffer.concat([received, data]);
          if (received.length < 1 + HANDSHAKE_SIZE * 2) return;
          if (received[0] !== 3) return failed('The server is not RTMP');
          reached = true;
          handshaken = true;
          socket.write(received.subarray(1, 1 + HANDSHAKE_SIZE));
          send([
            'connect',
            1,
            {
              app: application,
              type: 'nonprivate',
              flashVer: 'FMLE/3.0 (compatible; Alcantara)',
              tcUrl,
            },
          ]);
          data = received.subarray(1 + HANDSHAKE_SIZE * 2);
        }
        for (const message of reader.push(data)) {
          if (done) return;
          if (message.type === 20) command(message.payload);
          else if (message.type === 17) command(message.payload.subarray(1));
        }
      } catch {
        failed('The server answer could not be read');
      }
    });
  });
}
