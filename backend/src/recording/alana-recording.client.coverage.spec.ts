/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import {
  BadGatewayException,
  HttpException,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ManagedMetricsService } from '../observability/managed-metrics.service';
import {
  AlanaRecordingClient,
  type RecordingFetch,
} from './alana-recording.client';

const mockFetch = () => jest.fn() as jest.MockedFunction<RecordingFetch>;

const TOKEN = 'b'.repeat(64);

const body = (overrides: Record<string, unknown> = {}) => ({
  enabled: true,
  state: 'active',
  ...overrides,
});

function config(values: Record<string, string | undefined>) {
  return new ConfigService(values);
}

function make(
  transport: RecordingFetch,
  metrics = new ManagedMetricsService(),
) {
  return {
    metrics,
    client: new AlanaRecordingClient(
      config({
        NODE_ENV: 'test',
        ALANA_CONTROL_URL: 'http://alana:8080',
        ALANA_CONTROL_TOKEN: TOKEN,
      }),
      metrics,
      transport,
    ),
  };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected rejection');
}

describe('AlanaRecordingClient coverage', () => {
  let log: jest.SpyInstance;

  beforeEach(() => {
    log = jest.spyOn(Logger.prototype, 'log').mockImplementation();
  });
  afterEach(() => jest.restoreAllMocks());

  describe('constructor', () => {
    it('uses test defaults when NODE_ENV is test and nothing is configured', async () => {
      const fetchSpy = jest
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(Response.json(body()));
      const client = new AlanaRecordingClient(
        config({ NODE_ENV: 'test' }),
        new ManagedMetricsService(),
      );

      await client.status('p');

      expect(fetchSpy).toHaveBeenCalledWith(
        'http://alana:8080/v1/programs/p/recording',
        expect.objectContaining({
          headers: { Authorization: `Bearer ${'0'.repeat(64)}` },
        }),
      );
    });

    it('does not default URL or token outside of test', () => {
      expect(
        () =>
          new AlanaRecordingClient(
            config({ NODE_ENV: 'production' }),
            new ManagedMetricsService(),
          ),
      ).toThrow(/ALANA_CONTROL_URL/);
      expect(
        () =>
          new AlanaRecordingClient(
            config({
              NODE_ENV: 'production',
              ALANA_CONTROL_URL: 'http://alana:8080',
            }),
            new ManagedMetricsService(),
          ),
      ).toThrow('ALANA_CONTROL_TOKEN is missing or invalid');
    });
  });

  describe('status', () => {
    it('reports an http error on a read without auditing', async () => {
      const { client, metrics } = make(
        mockFetch().mockResolvedValue(
          Response.json(body({ error: 'disk-exhausted' }), { status: 503 }),
        ),
      );

      const error = (await rejection(client.status('p'))) as HttpException;

      expect(error.getStatus()).toBe(503);
      expect(error.getResponse()).toMatchObject({
        error: 'RECORDING_COMMAND_REJECTED',
        reason: 'disk-exhausted',
      });
      expect(log).not.toHaveBeenCalled();
      const output = await metrics.render('');
      expect(output).toContain('state="active",result="failure"');
      expect(output).not.toContain('alcantara_recording_commands_total{');
    });

    it('uses reason unknown when a failed read has no bounded evidence', async () => {
      const { client } = make(
        mockFetch().mockResolvedValue(Response.json(body(), { status: 500 })),
      );
      const error = (await rejection(client.status('p'))) as HttpException;
      expect(error.getResponse()).toMatchObject({ reason: 'unknown' });
    });

    it('maps a non-error HTTP status of a rejected response to 502', async () => {
      const { client } = make(
        mockFetch().mockResolvedValue(Response.json(body(), { status: 302 })),
      );
      const error = (await rejection(client.status('p'))) as HttpException;
      expect(error.getStatus()).toBe(502);
    });

    it('records invalid-response without auditing on a read', async () => {
      const { client } = make(mockFetch().mockResolvedValue(Response.json([])));
      await expect(client.status('p')).rejects.toBeInstanceOf(
        BadGatewayException,
      );
      expect(log).not.toHaveBeenCalled();
    });

    it('does not audit unavailable reads', async () => {
      const { client } = make(mockFetch().mockRejectedValue(new Error('down')));
      await expect(client.status('p')).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
      expect(log).not.toHaveBeenCalled();
    });
  });

  describe('command', () => {
    it('audits unavailable writes with status 503', async () => {
      const { client } = make(mockFetch().mockRejectedValue(new Error('down')));
      await expect(client.command('p', 'start', 'k')).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
      expect(JSON.parse(log.mock.calls[0][0] as string)).toEqual({
        event: 'recording-command',
        action: 'start',
        result: 'unavailable',
        status: 503,
      });
    });

    it('audits invalid-response writes with status 502', async () => {
      const { client } = make(mockFetch().mockResolvedValue(Response.json({})));
      await expect(client.command('p', 'stop', 'k')).rejects.toBeInstanceOf(
        BadGatewayException,
      );
      expect(JSON.parse(log.mock.calls[0][0] as string)).toEqual({
        event: 'recording-command',
        action: 'stop',
        result: 'invalid-response',
        status: 502,
      });
    });

    it('rejects a failed command using the bounded command result and audits it', async () => {
      const { client, metrics } = make(
        mockFetch().mockResolvedValue(
          Response.json(
            body({
              commandResult: {
                action: 'start',
                status: 409,
                result: 'already-active',
              },
            }),
            { status: 409 },
          ),
        ),
      );
      const error = (await rejection(
        client.command('p', 'start', 'k'),
      )) as HttpException;
      expect(error.getStatus()).toBe(409);
      expect(error.getResponse()).toMatchObject({
        reason: 'already-active',
      });
      expect(JSON.parse(log.mock.calls[0][0] as string)).toMatchObject({
        action: 'start',
        result: 'already-active',
        status: 409,
      });
      expect(await metrics.render('')).toContain(
        'alcantara_recording_commands_total{action="start",result="already-active"} 1',
      );
    });

    it('falls back to the status error when a failed command has no result', async () => {
      const { client } = make(
        mockFetch().mockResolvedValue(
          Response.json(body({ error: 'capture-failed' }), { status: 500 }),
        ),
      );
      const error = (await rejection(
        client.command('p', 'stop', 'k'),
      )) as HttpException;
      expect(error.getResponse()).toMatchObject({ reason: 'capture-failed' });
    });

    it('reports success when the accepted response has no command result', async () => {
      const transport = mockFetch().mockResolvedValue(Response.json(body()));
      const { client, metrics } = make(transport);

      await client.command('p', 'start', '');

      const [, init] = transport.mock
        .calls[0] as unknown as Parameters<RecordingFetch>;
      expect(init?.method).toBe('POST');
      expect(init?.headers).toEqual({ Authorization: `Bearer ${TOKEN}` });
      expect(JSON.parse(log.mock.calls[0][0] as string)).toMatchObject({
        result: 'success',
        status: 200,
      });
      expect(await metrics.render('')).toContain(
        'alcantara_recording_commands_total{action="start",result="success"} 1',
      );
    });
  });
});
