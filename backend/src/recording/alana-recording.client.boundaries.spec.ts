import {
  BadGatewayException,
  HttpException,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ManagedMetricsService } from '../observability/managed-metrics.service';
import {
  AlanaRecordingClient,
  type RecordingFetch,
} from './alana-recording.client';

const state = (override: Record<string, unknown> = {}) => ({
  enabled: true,
  state: 'active',
  ...override,
});
describe('recording client command failures and optional acknowledgements', () => {
  afterEach(() => jest.restoreAllMocks());
  function fixture(
    transport: RecordingFetch,
    configuration: Record<string, unknown> = { NODE_ENV: 'test' },
  ) {
    const metrics = {
      recordDependency: jest.fn(),
      recordRecordingStatus: jest.fn(),
      recordRecordingCommand: jest.fn(),
    };
    const client = new AlanaRecordingClient(
      new ConfigService(configuration),
      metrics as unknown as ManagedMetricsService,
      transport,
    );
    return { client, metrics };
  }

  it('requires explicit private configuration outside test mode', () => {
    expect(() => fixture(jest.fn(), { NODE_ENV: 'production' })).toThrow(
      'ALANA_CONTROL_URL',
    );
    expect(() =>
      fixture(jest.fn(), {
        NODE_ENV: 'production',
        ALANA_CONTROL_URL: 'http://alana:8080',
      }),
    ).toThrow('ALANA_CONTROL_TOKEN is missing or invalid');
  });

  it.each(['start', 'stop'] as const)(
    'records bounded %s audit and write dependency when transport is unavailable',
    async (action) => {
      const audit = jest.spyOn(Logger.prototype, 'log');
      const { client, metrics } = fixture(
        jest.fn().mockRejectedValue(new Error('private downstream detail')),
      );
      await expect(
        client.command('fixture', action, 'command'),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(metrics.recordDependency).toHaveBeenCalledWith(
        'alana',
        'write',
        'unavailable',
        expect.any(Number),
      );
      expect(audit).toHaveBeenCalledWith(
        JSON.stringify({
          event: 'recording-command',
          action,
          result: 'unavailable',
          status: 503,
        }),
      );
      expect(audit).not.toHaveBeenCalledWith(
        expect.stringContaining('private downstream'),
      );
    },
  );

  it.each(['start', 'stop'] as const)(
    'records invalid %s response separately from transport unavailability',
    async (action) => {
      const audit = jest.spyOn(Logger.prototype, 'log');
      const { client, metrics } = fixture(
        jest.fn().mockResolvedValue(new Response('not json')),
      );
      await expect(
        client.command('fixture', action, 'command'),
      ).rejects.toBeInstanceOf(BadGatewayException);
      expect(metrics.recordDependency).toHaveBeenCalledWith(
        'alana',
        'write',
        'invalid-response',
        expect.any(Number),
      );
      expect(audit).toHaveBeenCalledWith(
        JSON.stringify({
          event: 'recording-command',
          action,
          result: 'invalid-response',
          status: 502,
        }),
      );
      expect(metrics.recordRecordingCommand).not.toHaveBeenCalled();
    },
  );

  it.each([
    [state({ state: 'failed', error: 'capture-failed' }), 'capture-failed'],
    [state(), 'unknown'],
  ])(
    'uses bounded failure evidence when HTTP rejection has no command result (%#)',
    async (payload, expected) => {
      const { client, metrics } = fixture(
        jest.fn().mockResolvedValue(Response.json(payload, { status: 409 })),
      );
      let rejected: HttpException | undefined;
      try {
        await client.command('fixture', 'start', 'command');
      } catch (error) {
        if (!(error instanceof HttpException)) throw error;
        rejected = error;
      }
      expect(rejected?.getStatus()).toBe(409);
      expect(rejected?.getResponse()).toMatchObject({
        error: 'RECORDING_COMMAND_REJECTED',
        reason: expected,
      });
      expect(metrics.recordRecordingCommand).toHaveBeenCalledWith(
        'start',
        expected,
      );
    },
  );

  it('does not invent a command audit for a rejected status read and maps a non-error redirect to502', async () => {
    const audit = jest.spyOn(Logger.prototype, 'log');
    const { client, metrics } = fixture(
      jest.fn().mockResolvedValue(Response.json(state(), { status: 302 })),
    );
    let rejected: HttpException | undefined;
    try {
      await client.status('fixture');
    } catch (error) {
      if (!(error instanceof HttpException)) throw error;
      rejected = error;
    }
    expect(rejected?.getStatus()).toBe(502);
    expect(metrics.recordDependency).toHaveBeenCalledWith(
      'alana',
      'read',
      'http-error',
      expect.any(Number),
    );
    expect(metrics.recordRecordingCommand).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it('accepts a valid optional-acknowledgement response and keeps command metrics bounded', async () => {
    const { client, metrics } = fixture(
      jest.fn().mockResolvedValue(Response.json(state())),
    );
    await expect(
      client.command('fixture', 'stop', 'command'),
    ).resolves.toMatchObject({ state: 'active' });
    expect(metrics.recordRecordingCommand).toHaveBeenCalledWith(
      'stop',
      'success',
    );
  });
});
