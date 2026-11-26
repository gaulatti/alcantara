import * as net from 'node:net';
import { EventEmitter } from 'node:events';
import {
  ChunkReader,
  amfDecode,
  amfEncode,
  chunkCommand,
  connectRtmp,
  probeRtmp,
  safeMessage,
  type RtmpTarget,
} from './rtmp-probe';

// gaulatti/alcantara#384: the Test button's handshake against a fake RTMP server on a real socket. It must reach the
// publish command, send no media, and never let the key out in its answer.
const KEY = 'live key/secret'.replace(' ', '-');

type Behaviour = {
  connect?: 'ok' | 'error' | 'close';
  publish?: 'start' | 'bad' | 'silent' | 'close' | 'status';
  handshake?: 'ok' | 'not-rtmp' | 'silent';
};

const status = (level: string, code: string, description?: string) => [
  'onStatus',
  0,
  null,
  { level, code, ...(description ? { description } : {}) },
];

function fakeServer(behaviour: Behaviour) {
  const received: Array<unknown[]> = [];
  const types: number[] = [];
  const server = net.createServer((socket) => {
    const reader = new ChunkReader();
    let buffer = Buffer.alloc(0);
    let stage = 0;
    socket.on('error', () => undefined);
    const send = (values: unknown[]) =>
      socket.write(chunkCommand(amfEncode(values as never), 0));
    const handle = (values: unknown[]) => {
      received.push(values);
      const [name, transaction] = values as [string, number];
      if (name === 'connect') {
        if (behaviour.connect === 'close') return socket.end();
        // A protocol control message first: chunk size 4096 on chunk stream 2.
        const size = Buffer.from([2, 0, 0, 0, 0, 0, 4, 1, 0, 0, 0, 0]);
        const value = Buffer.alloc(4);
        value.writeUInt32BE(128);
        socket.write(Buffer.concat([size, value]));
        if (behaviour.connect === 'error')
          return send([
            '_error',
            1,
            null,
            { level: 'error', description: `no such app for ${KEY}` },
          ]);
        send(['_result', 1, {}, { code: 'NetConnection.Connect.Success' }]);
      }
      if (name === 'releaseStream')
        send(['_error', transaction, null, { code: 'ignored' }]);
      if (name === 'createStream') send(['_result', 4, null, 1]);
      if (name === 'publish') {
        if (behaviour.publish === 'close') send(['close', 0, null]);
        else if (behaviour.publish === 'bad')
          send(status('error', 'NetStream.Publish.BadName', `bad ${KEY}`));
        else if (behaviour.publish !== 'silent') {
          send(status('status', 'NetStream.Publish.Idle'));
          send(status('status', 'NetStream.Publish.Start'));
        }
      }
    };
    socket.on('data', (data) => {
      if (stage < 2) {
        buffer = Buffer.concat([buffer, data]);
        if (stage === 0) {
          if (buffer.length < 1537) return;
          if (behaviour.handshake === 'silent') return;
          if (behaviour.handshake === 'not-rtmp')
            return socket.write(Buffer.alloc(3073, 72));
          socket.write(
            Buffer.concat([
              Buffer.from([3]),
              Buffer.alloc(1536, 1),
              buffer.subarray(1, 1537),
            ]),
          );
          buffer = buffer.subarray(1537);
          stage = 1;
        }
        if (buffer.length < 1536) return;
        data = buffer.subarray(1536);
        stage = 2;
      }
      for (const message of reader.push(data)) {
        types.push(message.type);
        if (message.type === 20) handle(amfDecode(message.payload));
      }
    });
  });
  return { server, received, types };
}

async function run(behaviour: Behaviour, timeoutMs = 2000) {
  const fake = fakeServer(behaviour);
  await new Promise<void>((resolve) =>
    fake.server.listen(0, '127.0.0.1', resolve),
  );
  const target: RtmpTarget = {
    scheme: 'rtmp',
    host: 'ingest.example.test',
    port: (fake.server.address() as net.AddressInfo).port,
    application: 'live2',
    streamKey: KEY,
    address: '127.0.0.1',
  };
  const result = await probeRtmp(target, timeoutMs);
  fake.server.close();
  return { result, ...fake, target };
}

describe('probeRtmp', () => {
  it('connects, creates a stream, publishes the key and answers accepted, sending only commands', async () => {
    const out = await run({});
    expect(out.result).toEqual({ result: 'accepted' });
    const names = out.received.map((values) => values[0]);
    expect(names.slice(0, 5)).toEqual([
      'connect',
      'releaseStream',
      'FCPublish',
      'createStream',
      'publish',
    ]);
    expect(out.received[0][2]).toMatchObject({
      app: 'live2',
      tcUrl: `rtmp://ingest.example.test:${out.target.port}/live2`,
    });
    expect(out.received[4].slice(3)).toEqual([KEY, 'live']);
    // No audio (8) or video (9) message was sent.
    expect(out.types.filter((type) => type === 8 || type === 9)).toEqual([]);
  });

  it('answers the server refusal, with the key taken out, at connect and at publish', async () => {
    for (const behaviour of [
      { connect: 'error' } as const,
      { publish: 'bad' } as const,
    ]) {
      const { result } = await run(behaviour);
      expect(result.result).toBe('refused');
      expect(JSON.stringify(result)).not.toContain(KEY);
      expect(JSON.stringify(result)).toContain('[key]');
    }
  });

  it('reports a server that closes the stream or the connection as refused', async () => {
    await expect(run({ publish: 'close' })).resolves.toMatchObject({
      result: { result: 'refused', message: 'The server closed the stream' },
    });
    await expect(run({ connect: 'close' })).resolves.toMatchObject({
      result: {
        result: 'refused',
        message: 'The server closed the connection',
      },
    });
  });

  it('times out: unreachable before the handshake, refused after it', async () => {
    await expect(run({ handshake: 'silent' }, 200)).resolves.toMatchObject({
      result: { result: 'unreachable' },
    });
    await expect(run({ publish: 'silent' }, 300)).resolves.toMatchObject({
      result: {
        result: 'refused',
        message: 'The server did not answer in time',
      },
    });
  });

  it('says a server that is not RTMP is unreachable, and one that cannot be dialled', async () => {
    await expect(run({ handshake: 'not-rtmp' })).resolves.toMatchObject({
      result: { result: 'unreachable', message: 'The server is not RTMP' },
    });
    const socket = new EventEmitter() as EventEmitter & {
      write: jest.Mock;
      destroy: jest.Mock;
    };
    socket.write = jest.fn();
    socket.destroy = jest.fn();
    const pending = probeRtmp(
      {
        scheme: 'rtmps',
        host: '2001:db8::1',
        application: 'live2',
        streamKey: KEY,
        address: '2001:db8::1',
      },
      1000,
      ({ port }) => {
        expect(port).toBe(443);
        setImmediate(() => {
          socket.emit('secureConnect');
          socket.emit('error', new Error('reset'));
          socket.emit('close');
        });
        return socket as never;
      },
    );
    await expect(pending).resolves.toEqual({
      result: 'unreachable',
      message: 'The connection failed',
    });
    expect(socket.write).toHaveBeenCalledTimes(1);
  });

  it('gives up on an answer it cannot read, and uses 1935 for rtmp by default', async () => {
    const socket = new EventEmitter() as EventEmitter & {
      write: jest.Mock;
      destroy: jest.Mock;
    };
    socket.write = jest.fn();
    socket.destroy = jest.fn();
    const pending = probeRtmp(
      {
        scheme: 'rtmp',
        host: 'ingest.example.test',
        application: 'live2',
        streamKey: KEY,
        address: '192.0.2.1',
      },
      1000,
      ({ port }) => {
        expect(port).toBe(1935);
        setImmediate(() => {
          socket.emit('data', Buffer.from([3]));
          socket.emit(
            'data',
            Buffer.concat([
              Buffer.alloc(3072),
              chunkCommand(Buffer.from([99]), 0),
            ]),
          );
        });
        return socket as never;
      },
    );
    await expect(pending).resolves.toEqual({
      result: 'refused',
      message: 'The server answer could not be read',
    });
  });

  it('reads an AMF3 command message by skipping its first byte', async () => {
    const socket = new EventEmitter() as EventEmitter & {
      write: jest.Mock;
      destroy: jest.Mock;
    };
    socket.write = jest.fn();
    socket.destroy = jest.fn();
    const frame = chunkCommand(
      Buffer.concat([
        Buffer.from([0]),
        amfEncode(['_error', 1, null, { code: 'NetConnection.Rejected' }]),
      ]),
      0,
    );
    frame[7] = 17;
    const pending = probeRtmp(
      {
        scheme: 'rtmp',
        host: 'ingest.example.test',
        application: 'live2',
        streamKey: KEY,
        address: '192.0.2.1',
      },
      1000,
      () => {
        setImmediate(() =>
          socket.emit(
            'data',
            Buffer.concat([Buffer.from([3]), Buffer.alloc(3072), frame]),
          ),
        );
        return socket as never;
      },
    );
    await expect(pending).resolves.toEqual({
      result: 'refused',
      message: 'NetConnection.Rejected',
    });
  });

  it('falls back to stream 1, ignores what follows its answer and handles a server close message', async () => {
    const answer = (frames: Buffer[]) => {
      const socket = new EventEmitter() as EventEmitter & {
        write: jest.Mock;
        destroy: jest.Mock;
      };
      socket.write = jest.fn();
      socket.destroy = jest.fn();
      const pending = probeRtmp(
        {
          scheme: 'rtmp',
          host: 'ingest.example.test',
          application: 'live2',
          streamKey: KEY,
          address: '192.0.2.1',
        },
        1000,
        () => {
          setImmediate(() =>
            socket.emit(
              'data',
              Buffer.concat([Buffer.from([3]), Buffer.alloc(3072), ...frames]),
            ),
          );
          return socket as never;
        },
      );
      return { pending, socket };
    };
    const frame = (values: unknown[]) =>
      chunkCommand(amfEncode(values as never), 0);
    // A window-acknowledgement message and an unknown command are passed over.
    const acknowledgement = chunkCommand(Buffer.alloc(4), 0);
    acknowledgement[7] = 5;
    const first = answer([
      acknowledgement,
      frame(['onBWDone', 0, null]),
      frame(['_result', 4, null, null]),
      frame(['onStatus', 0, null, { code: 'NetStream.Publish.Start' }]),
      frame(['_error', 1, null, { code: 'late' }]),
    ]);
    await expect(first.pending).resolves.toEqual({ result: 'accepted' });
    // publish went to stream 1 when createStream gave no number.
    const publish = first.socket.write.mock.calls
      .map(([data]) => data as Buffer)
      .find((data) => data.includes('publish'))!;
    expect(publish.readUInt32LE(8)).toBe(1);
    await expect(answer([frame(['close', 0, null])]).pending).resolves.toEqual({
      result: 'refused',
      message: 'The server closed the stream',
    });
  });

  it('dials TLS for rtmps and a plain socket for rtmp', () => {
    for (const [scheme, host] of [
      ['rtmps', 'ingest.example.test'],
      ['rtmps', '127.0.0.1'],
      ['rtmp', 'ingest.example.test'],
    ] as const) {
      const socket = connectRtmp({
        scheme,
        host,
        address: '127.0.0.1',
        port: 1,
      });
      socket.on('error', () => undefined);
      expect(socket).toBeInstanceOf(net.Socket);
      socket.destroy();
    }
  });
});

describe('RTMP encoding', () => {
  it('round-trips AMF values and splits a long command into chunks the reader joins', () => {
    const values = [
      'x'.repeat(400),
      7,
      true,
      false,
      null,
      { a: { b: 'c' }, d: 1 },
    ];
    expect(amfDecode(amfEncode(values as never))).toEqual(values);
    const framed = chunkCommand(amfEncode(values as never), 1);
    const reader = new ChunkReader();
    const messages = [...framed].flatMap((byte) =>
      reader.push(Buffer.from([byte])),
    );
    expect(messages).toHaveLength(1);
    expect(amfDecode(messages[0].payload)).toEqual(values);
  });

  it('reads an ECMA array and undefined, and refuses a type it does not know', () => {
    const ecma = Buffer.from([
      8, 0, 0, 0, 1, 0, 1, 97, 2, 0, 1, 98, 0, 0, 9, 6,
    ]);
    expect(amfDecode(ecma)).toEqual([{ a: 'b' }, null]);
    expect(() => amfDecode(Buffer.from([11]))).toThrow('unsupported');
  });

  it('reads long chunk stream ids, timestamp extensions and header types 1 to 3', () => {
    const reader = new ChunkReader();
    // Two-byte and three-byte stream ids, format 0 with an extended timestamp.
    const header = (basic: number[], length: number) => [
      ...basic,
      0xff,
      0xff,
      0xff,
      0,
      0,
      length,
      20,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      1,
    ];
    expect(reader.push(Buffer.from([...header([0, 1], 1), 5]))).toHaveLength(1);
    expect(reader.push(Buffer.from([...header([1, 1, 0], 1), 5]))).toHaveLength(
      1,
    );
    // Format 1 and 2 on a known stream, then format 3 carrying the same header.
    expect(
      reader.push(Buffer.from([0x40, 1, 0, 0, 0, 0, 0, 1, 20, 5])),
    ).toHaveLength(1);
    expect(reader.push(Buffer.from([0x80, 1, 0, 0, 0, 5]))).toHaveLength(1);
    expect(reader.push(Buffer.from([0xc0, 1, 5]))).toHaveLength(1);
    expect(reader.push(Buffer.alloc(0))).toEqual([]);
  });

  it('waits for the rest of a long chunk stream id', () => {
    expect(new ChunkReader().push(Buffer.from([0]))).toEqual([]);
    expect(new ChunkReader().push(Buffer.from([1, 1]))).toEqual([]);
  });

  it('refuses a zero chunk size and an oversized message', () => {
    const zero = Buffer.from([2, 0, 0, 0, 0, 0, 4, 1, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(() => new ChunkReader().push(zero)).toThrow('bad chunk size');
    const huge = Buffer.from([3, 0, 0, 0, 0xff, 0xff, 0xff, 20, 0, 0, 0, 0]);
    expect(() => new ChunkReader().push(huge)).toThrow('too large');
  });

  it('says refused when the server gives no words, and cuts long ones', () => {
    expect(safeMessage(undefined, KEY)).toBe('The server refused');
    expect(safeMessage('', KEY)).toBe('The server refused');
    expect(safeMessage('a'.repeat(500), KEY)).toHaveLength(200);
    expect(safeMessage(`k=${encodeURIComponent(KEY)}`, KEY)).toBe('k=[key]');
  });
});
