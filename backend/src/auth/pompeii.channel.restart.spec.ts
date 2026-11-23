import {
  Server,
  ServerCredentials,
  credentials,
  loadPackageDefinition,
  status,
  type ServiceError,
  type UntypedServiceImplementation,
} from '@grpc/grpc-js';
import { loadSync } from '@grpc/proto-loader';
import { createConnection, createServer, type Socket } from 'node:net';
import { join } from 'node:path';
import { POMPEII_CHANNEL_OPTIONS, PompeiiChannel } from './pompeii.service';

// gaulatti/alcantara#225: a Pompeii deploy swaps its container while
// Alcantara keeps running. The connection through the old path is black-holed
// (no reset, no error) and calls on it only time out. These tests run real
// gRPC stubs behind a TCP proxy that does exactly that to its existing
// connections, and check that the next call reaches the new stub.

const definition = loadSync(
  join(__dirname, '..', 'proto', 'authorization.proto'),
  {
    defaults: true,
    enums: String,
    keepCase: true,
    longs: String,
    oneofs: true,
  },
);
const loaded = loadPackageDefinition(definition) as unknown as {
  pompeii: {
    authorization: {
      v1: {
        AuthorizationService: (new (
          address: string,
          creds: ReturnType<typeof credentials.createInsecure>,
          options?: Record<string, number>,
        ) => never) & { service: never };
      };
    };
  };
};
const Service = loaded.pompeii.authorization.v1.AuthorizationService;

async function stub(
  subject: string,
  delayMs = 0,
): Promise<{ port: number; server: Server }> {
  const server = new Server();
  const implementation: UntypedServiceImplementation = {
    Authorize: (_call: unknown, callback: (e: null, v: unknown) => void) => {
      setTimeout(
        () => callback(null, { authenticated: true, allowed: true, subject }),
        delayMs,
      );
    },
  };
  server.addService(Service.service, implementation);
  const port = await new Promise<number>((resolve, reject) =>
    server.bindAsync(
      '127.0.0.1:0',
      ServerCredentials.createInsecure(),
      (e, p) => (e ? reject(e) : resolve(p)),
    ),
  );
  return { port, server };
}

/** Forwards to the current upstream; `swap` black-holes every existing connection. */
async function proxy(upstream: number) {
  let target = upstream;
  const live = new Set<{ client: Socket; upstream: Socket }>();
  const all: Socket[] = [];
  const server = createServer((client) => {
    const pair = { client, upstream: createConnection(target, '127.0.0.1') };
    all.push(client, pair.upstream);
    live.add(pair);
    client.pipe(pair.upstream);
    pair.upstream.pipe(client);
    client.on('error', () => undefined);
    pair.upstream.on('error', () => undefined);
  });
  const port = await new Promise<number>((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve((server.address() as { port: number }).port),
    ),
  );
  return {
    port,
    swap(next: number) {
      target = next;
      for (const pair of live) {
        // The old path silently stops carrying bytes, in both directions.
        pair.client.unpipe(pair.upstream);
        pair.upstream.unpipe(pair.client);
        pair.client.removeAllListeners('data');
        pair.client.on('data', () => undefined);
        pair.upstream.destroy();
      }
      live.clear();
    },
    close() {
      for (const socket of all) socket.destroy();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

const request = {
  bearer_token: 't',
  permission: 'alcantara:access',
  team_id: 0,
};

describe('PompeiiChannel against a restarted Pompeii', () => {
  const cleanup: Array<() => unknown> = [];
  afterEach(async () => {
    for (const step of cleanup.reverse()) await step();
    cleanup.length = 0;
  });

  function channelTo(port: number, resets: string[], intervalMs?: number) {
    const channel = new PompeiiChannel(
      () =>
        new Service(
          `127.0.0.1:${port}`,
          credentials.createInsecure(),
          POMPEII_CHANNEL_OPTIONS,
        ),
      (reason) => resets.push(reason),
      intervalMs,
    );
    cleanup.push(() => channel.close());
    return channel;
  }

  it('fails one call on the black-holed connection, then reaches the new container', async () => {
    const before = await stub('before');
    const after = await stub('after');
    const front = await proxy(before.port);
    cleanup.push(
      () => before.server.forceShutdown(),
      () => after.server.forceShutdown(),
      () => front.close(),
    );
    const resets: string[] = [];
    const channel = channelTo(front.port, resets);
    // A plain client with no replacement, as Alcantara had before #225.
    const plain = new Service(
      `127.0.0.1:${front.port}`,
      credentials.createInsecure(),
      POMPEII_CHANNEL_OPTIONS,
    ) as unknown as {
      authorize: (
        r: unknown,
        o: { deadline: Date },
        cb: (e: ServiceError | null, v?: { subject: string }) => void,
      ) => void;
      close: () => void;
    };
    cleanup.push(() => plain.close());
    const plainCall = () =>
      new Promise<{ subject?: string; code?: number }>((resolve) =>
        plain.authorize(
          request,
          { deadline: new Date(Date.now() + 300) },
          (e, v) => resolve(e ? { code: e.code } : { subject: v?.subject }),
        ),
      );

    await expect(channel.authorize(request, 1_000)).resolves.toMatchObject({
      subject: 'before',
    });
    await expect(plainCall()).resolves.toEqual({ subject: 'before' });

    front.swap(after.port);
    before.server.forceShutdown();

    // The call on the dead path times out and is still a failure.
    await expect(channel.authorize(request, 300)).rejects.toMatchObject({
      code: status.DEADLINE_EXCEEDED,
    });
    expect(resets).toEqual(['deadline_exceeded']);
    // The next call dials a new connection and reaches the new container.
    await expect(channel.authorize(request, 1_000)).resolves.toMatchObject({
      subject: 'after',
    });
    // Without replacement the old connection stays dead.
    await expect(plainCall()).resolves.toEqual({
      code: status.DEADLINE_EXCEEDED,
    });
    await expect(plainCall()).resolves.toEqual({
      code: status.DEADLINE_EXCEEDED,
    });
  }, 15_000);

  it('does not redial on every call while Pompeii is slower than the deadline', async () => {
    const slow = await stub('slow', 3_000);
    cleanup.push(() => slow.server.forceShutdown());
    const resets: string[] = [];
    const channel = channelTo(slow.port, resets, 5_000);
    const results: unknown[] = [];
    for (let attempt = 0; attempt < 4; attempt += 1) {
      results.push(
        await channel.authorize(request, 200).then(
          () => 'allowed',
          (e: ServiceError) => e.code,
        ),
      );
    }
    // Every call fails (and so denies); the channel is replaced once.
    expect(results).toEqual([4, 4, 4, 4]);
    expect(resets).toEqual(['deadline_exceeded']);
  }, 15_000);
});
