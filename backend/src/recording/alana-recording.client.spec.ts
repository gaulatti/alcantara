import { ConfigService } from '@nestjs/config';
import {
  BadGatewayException,
  HttpException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ManagedMetricsService } from '../observability/managed-metrics.service';
import {
  AlanaRecordingClient,
  type RecordingFetch,
} from './alana-recording.client';

const TOKEN =
  'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const BASE_URL = 'http://alana:8080';

const status = (overrides: Record<string, unknown> = {}) => ({
  enabled: true,
  state: 'active',
  requestedAt: '2026-09-06T18:00:00Z',
  startedAt: '2026-09-06T18:00:01Z',
  stoppedAt: null,
  finalizedAt: null,
  updatedAt: '2026-09-06T18:00:02Z',
  segmentCount: 2,
  bytes: 2000,
  durationSeconds: 10,
  droppedFrames: 0,
  errors: 0,
  restarts: 0,
  finalizationState: 'not-requested',
  finalBytes: 0,
  error: null,
  disk: {
    freeBytes: 10_000,
    usageBytes: 2_000,
    quotaBytes: 20_000,
    minimumFreeBytes: 1_000,
  },
  ...overrides,
});

function config(values: Record<string, string> = {}) {
  return new ConfigService({
    NODE_ENV: 'test',
    ALANA_CONTROL_URL: BASE_URL,
    ALANA_CONTROL_TOKEN: TOKEN,
    ...values,
  });
}

describe('AlanaRecordingClient', () => {
  it('reads the exact program-scoped Alana status and keeps only bounded fields', async () => {
    const transport = jest.fn<RecordingFetch>().mockResolvedValue(
      Response.json(
        status({
          operationId: 'private-operation',
          path: '/var/lib/alana/private.mp4',
          finalSha256: 'private-artifact-hash',
        }),
      ),
    );
    const metrics = new ManagedMetricsService();
    const client = new AlanaRecordingClient(config(), metrics, transport);

    const result = await client.status('modo italiano');

    expect(transport).toHaveBeenCalledWith(
      'http://alana:8080/v1/programs/modo%20italiano/recording',
      expect.objectContaining({
        method: 'GET',
        headers: { Authorization: `Bearer ${TOKEN}` },
      }),
    );
    expect(result).toMatchObject({ state: 'active', segmentCount: 2 });
    expect(result).not.toHaveProperty('operationId');
    expect(result).not.toHaveProperty('path');
    expect(result).not.toHaveProperty('finalSha256');
    expect(await metrics.render('')).toContain(
      'alcantara_recording_reconciliations_total{state="active",result="success"} 1',
    );
  });

  it('forwards one bounded idempotency key with no command body', async () => {
    const transport = jest.fn<RecordingFetch>().mockResolvedValue(
      Response.json(
        status({
          state: 'requested',
          commandResult: {
            action: 'start',
            status: 202,
            result: 'accepted',
          },
        }),
        { status: 202 },
      ),
    );
    const metrics = new ManagedMetricsService();
    const client = new AlanaRecordingClient(config(), metrics, transport);

    const result = await client.command(
      'modoitaliano',
      'start',
      'recording-start-1',
    );

    expect(result.state).toBe('requested');
    const [url, init] = transport.mock
      .calls[0] as unknown as Parameters<RecordingFetch>;
    expect(url).toBe(
      'http://alana:8080/v1/programs/modoitaliano/recording/start',
    );
    expect(init).not.toHaveProperty('body');
    expect(init?.headers).toEqual({
      Authorization: `Bearer ${TOKEN}`,
      'Idempotency-Key': 'recording-start-1',
    });
    const output = await metrics.render('');
    expect(output).toContain(
      'alcantara_recording_commands_total{action="start",result="accepted"} 1',
    );
    expect(output).not.toContain(TOKEN);
    expect(output).not.toContain('modoitaliano');
  });

  it('returns only bounded Alana rejection evidence', async () => {
    const transport = jest.fn<RecordingFetch>().mockResolvedValue(
      Response.json(
        status({
          state: 'failed',
          error: '/private/path/provider-detail',
          commandResult: {
            action: 'stop',
            status: 500,
            result: '/private/path/provider-detail',
          },
        }),
        { status: 500 },
      ),
    );
    const client = new AlanaRecordingClient(
      config(),
      new ManagedMetricsService(),
      transport,
    );

    let rejection: unknown;
    try {
      await client.command('modoitaliano', 'stop', 'recording-stop-1');
    } catch (error) {
      rejection = error;
    }
    expect(rejection).toBeInstanceOf(HttpException);
    const response = (rejection as HttpException).getResponse();
    expect(response).toMatchObject({ reason: 'unknown' });
  });

  it('fails closed on unavailable or malformed Alana responses', async () => {
    const unavailable = new AlanaRecordingClient(
      config(),
      new ManagedMetricsService(),
      jest
        .fn<RecordingFetch>()
        .mockRejectedValue(new Error('private provider detail')),
    );
    const malformed = new AlanaRecordingClient(
      config(),
      new ManagedMetricsService(),
      jest
        .fn<RecordingFetch>()
        .mockResolvedValue(Response.json({ state: 'active' })),
    );

    await expect(unavailable.status('modoitaliano')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    await expect(malformed.status('modoitaliano')).rejects.toBeInstanceOf(
      BadGatewayException,
    );
  });

  it('rejects credentials and non-origin targets before making a request', () => {
    expect(
      () =>
        new AlanaRecordingClient(
          config({ ALANA_CONTROL_TOKEN: 'short' }),
          new ManagedMetricsService(),
        ),
    ).toThrow('ALANA_CONTROL_TOKEN is missing or invalid');
    expect(
      () =>
        new AlanaRecordingClient(
          config({ ALANA_CONTROL_URL: 'http://user:secret@alana:8080/path' }),
          new ManagedMetricsService(),
        ),
    ).toThrow('ALANA_CONTROL_URL contains an invalid URL');
  });
});
