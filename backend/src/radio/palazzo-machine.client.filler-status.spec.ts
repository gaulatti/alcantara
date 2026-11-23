import { ConfigService } from '@nestjs/config';
import {
  PalazzoMachineClient,
  PalazzoMachineError,
} from './palazzo-machine.client';
import { RadioMetricsService } from './radio-metrics.service';

// gaulatti/ariston#217: the filler prepare answer binds on `ready: true` and
// the exact version echo. A `status` Alcantara does not know is counted, not a
// failed preparation.

const PROGRAM_ID = 'radio-1';
const BASE_URL = 'http://palazzo:3100';
const ASSETS = [
  { id: 'song-1', sha256: 'a'.repeat(64), downloadUrl: 'https://a.test/a.mp3' },
];

function setup(body: unknown) {
  const metrics = new RadioMetricsService();
  const client = new PalazzoMachineClient(
    {
      get: (key: string) =>
        ({ NODE_ENV: 'test', PALAZZO_ALLOWED_URLS: BASE_URL })[key],
    } as unknown as ConfigService,
    metrics,
    jest.fn().mockResolvedValue(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    ) as unknown as typeof fetch,
  );
  return { client, metrics };
}

const series = (metrics: RadioMetricsService, result: string) =>
  Number(
    metrics
      .render()
      .split('\n')
      .find((line) =>
        line.startsWith(
          `alcantara_palazzo_machine_requests_total{operation="filler-prepare",result="${result}"} `,
        ),
      )
      ?.split(' ')
      .pop(),
  );

describe('PalazzoMachineClient.prepareFiller: unknown status', () => {
  it('accepts a ready answer with an unknown status and counts it', async () => {
    const { client, metrics } = setup({
      version: 'v1',
      ready: true,
      status: 'ready-and-verified',
    });
    await expect(
      client.prepareFiller(BASE_URL, PROGRAM_ID, 'v1', ASSETS),
    ).resolves.toBeUndefined();
    expect(series(metrics, 'unknown-value')).toBe(1);
    expect(series(metrics, 'success')).toBe(0);
    expect(metrics.render()).not.toContain('ready-and-verified');
  });

  it('counts a known ready answer as success', async () => {
    const { client, metrics } = setup({
      version: 'v1',
      ready: true,
      status: 'ready',
    });
    await client.prepareFiller(BASE_URL, PROGRAM_ID, 'v1', ASSETS);
    expect(series(metrics, 'success')).toBe(1);
    expect(series(metrics, 'unknown-value')).toBe(0);
  });

  it.each([
    ['a version echo mismatch', { version: 'v2', ready: true, status: 'x' }],
    ['not ready', { version: 'v1', ready: false, status: 'x' }],
    [
      'a contradicting failed status',
      { version: 'v1', ready: true, status: 'failed' },
    ],
  ])('still fails for %s', async (_name, body) => {
    const { client, metrics } = setup(body);
    await expect(
      client.prepareFiller(BASE_URL, PROGRAM_ID, 'v1', ASSETS),
    ).rejects.toEqual(new PalazzoMachineError('malformed'));
    expect(series(metrics, 'unknown-value')).toBe(0);
  });
});
