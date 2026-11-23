import { NowPlayingPublisherService } from './now-playing-publisher.service';
import type { PrismaService } from '../prisma.service';
import { ManagedMetricsService } from '../observability/managed-metrics.service';
import {
  scriptedTransport,
  type ScriptedResponse,
} from '../outbound/safe-fetch.testing';

// Every now-playing delivery goes through the outbound-request policy:
// public addresses only, checked after DNS and on each redirect, with the
// connection made to the checked address. No log line carries the address
// or the payload.

const names: Record<string, string[]> = {
  'hook.example.test': ['93.184.216.34'],
  'inside.example.test': ['10.20.30.40'],
  'mixed.example.test': ['93.184.216.34', '127.0.0.1'],
};

async function deliver(url: string, script: Record<string, ScriptedResponse>) {
  const prisma = {
    nowPlayingConsumer: {
      findMany: jest
        .fn()
        .mockResolvedValue([
          { name: 'listener', url, method: 'POST', headers: {} },
        ]),
    },
  };
  const metrics = new ManagedMetricsService();
  const service = new NowPlayingPublisherService(
    prisma as unknown as PrismaService,
    metrics,
  );
  const transport = scriptedTransport(names, script);
  service.outboundDeps = transport;
  const lines: string[] = [];
  for (const level of ['log', 'warn', 'error'] as const)
    jest
      .spyOn(service['logger'], level)
      .mockImplementation((message: unknown) => {
        lines.push(String(message));
      });

  await service.publishStopped('main');

  const text = await metrics.registry.metrics();
  const sample = (result: string) =>
    text
      .split('\n')
      .find((line) =>
        line.startsWith(
          `alcantara_outbound_fetch_total{path="now_playing",result="${result}"}`,
        ),
      );
  return { sent: transport.sent, lines, sample, text };
}

describe('now-playing delivery under the outbound-request policy', () => {
  afterEach(() => jest.restoreAllMocks());

  it('delivers to a public https consumer, connecting to the checked address', async () => {
    const { sent, lines, sample } = await deliver(
      'https://hook.example.test/np',
      { 'hook.example.test/np': { status: 204 } },
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      scheme: 'https:',
      hostname: 'hook.example.test',
      servername: 'hook.example.test',
      connectedTo: '93.184.216.34',
      body: '{"status":"stopped"}',
    });
    expect(sample('ok')).toMatch(/ 1$/);
    expect(lines).toContain(
      'Now-playing publish succeeded for main/listener: 204',
    );
  });

  it('refuses a consumer at a non-public address without connecting', async () => {
    const { sent, lines, sample } = await deliver('https://10.0.0.5/np', {
      '10.0.0.5/np': { status: 204 },
    });
    expect(sent).toEqual([]);
    expect(sample('address')).toMatch(/ 1$/);
    expect(lines).toContain(
      'Now-playing publish failed for main/listener: address',
    );
  });

  it('refuses a consumer whose name resolves to a non-public address', async () => {
    for (const host of ['inside.example.test', 'mixed.example.test']) {
      const { sent, sample } = await deliver(`https://${host}/np`, {
        [`${host}/np`]: { status: 204 },
      });
      expect(sent).toEqual([]);
      expect(sample('address')).toMatch(/ 1$/);
    }
  });

  it('refuses a redirect to a non-public address', async () => {
    const { sent, sample } = await deliver('https://hook.example.test/np', {
      'hook.example.test/np': {
        status: 307,
        headers: { location: 'https://inside.example.test/np' },
      },
      'inside.example.test/np': { status: 204 },
    });
    expect(sent.map((request) => request.hostname)).toEqual([
      'hook.example.test',
    ]);
    expect(sample('address')).toMatch(/ 1$/);
  });

  it('delivers a stored http consumer to a public address and counts it as legacy_http', async () => {
    const { sent, lines, sample } = await deliver(
      'http://hook.example.test/np',
      { 'hook.example.test/np': { status: 200 } },
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      scheme: 'http:',
      connectedTo: '93.184.216.34',
    });
    expect(sample('legacy_http')).toMatch(/ 1$/);
    expect(sample('ok')).toMatch(/ 0$/);
    expect(lines).toContain(
      'Now-playing consumer main/listener uses plain http; change its URL to https',
    );
  });

  it('refuses a stored http consumer at a non-public address', async () => {
    const { sent, sample } = await deliver('http://inside.example.test/np', {
      'inside.example.test/np': { status: 200 },
    });
    expect(sent).toEqual([]);
    expect(sample('address')).toMatch(/ 1$/);
    expect(sample('legacy_http')).toMatch(/ 0$/);
  });

  it('logs no URL and no payload, and puts no URL in a metric label', async () => {
    const runs = [
      await deliver('https://hook.example.test/np?key=private', {
        'hook.example.test/np?key=private': { status: 204 },
      }),
      await deliver('https://hook.example.test/np?key=private', {
        'hook.example.test/np?key=private': {
          status: 500,
          body: Buffer.from('upstream detail'),
        },
      }),
      await deliver('http://inside.example.test/np', {}),
    ];
    for (const { lines, text } of runs) {
      const logged = lines.join('\n');
      expect(lines.length).toBeGreaterThan(0);
      expect(logged).not.toMatch(/https?:\/\//);
      expect(logged).not.toContain('example.test');
      expect(logged).not.toContain('private');
      expect(logged).not.toContain('"status"');
      expect(logged).not.toContain('upstream detail');
      expect(text).not.toContain('example.test');
    }
  });
});
