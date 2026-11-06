/* eslint-disable @typescript-eslint/no-require-imports */
import { ConfigService } from '@nestjs/config';
import { ManagedMetricsService } from '../observability/managed-metrics.service';
import {
  AlanaClient,
  AlanaRequestError,
  normalizeAlanaBaseUrl,
  sanitizeAlanaState,
} from './alana.client';

const selection = {
  version: 'destinations-test-1',
  destinations: [
    { id: 'primary', secretId: 'broadcast/test/primary', versionId: 'v1' },
  ],
};

const HASH = 'c'.repeat(64);

function configWith(values: Record<string, string | undefined>) {
  return {
    get: jest.fn((key: string) => values[key]),
  } as unknown as ConfigService;
}

describe('AlanaClient coverage', () => {
  const recordDependency = jest.fn();
  const metrics = { recordDependency } as unknown as ManagedMetricsService;

  beforeEach(() => {
    jest.restoreAllMocks();
    recordDependency.mockReset();
  });

  const client = () =>
    new AlanaClient(
      configWith({
        NODE_ENV: 'test',
        ALANA_CONTROL_URL: 'http://alana.test:8080',
        ALANA_CONTROL_TOKEN: '  fictional-alana-control-token  ',
      }),
      metrics,
    );

  describe('AlanaRequestError', () => {
    const base = sanitizeAlanaState({});
    it('uses the state error as the message when present', () => {
      const error = new AlanaRequestError(409, { ...base, error: 'conflict' });
      expect(error.message).toBe('conflict');
      expect(error.status).toBe(409);
    });
    it('falls back to a status based message', () => {
      expect(new AlanaRequestError(500, base).message).toBe(
        'Alana request failed with HTTP 500',
      );
    });
  });

  describe('constructor', () => {
    it('uses test defaults when NODE_ENV is test and nothing is configured', async () => {
      const fetchMock = jest
        .spyOn(global, 'fetch')
        .mockResolvedValue(Response.json({}));
      const instance = new AlanaClient(
        configWith({ NODE_ENV: 'test' }),
        metrics,
      );
      await instance.status('main');
      expect(fetchMock).toHaveBeenCalledWith(
        'http://alana.test:8080/v1/programs/main/lifecycle',
        expect.objectContaining({
          headers: { Authorization: 'Bearer alana-test-control-token' },
        }),
      );
    });

    it('defaults NODE_ENV to development and requires explicit configuration', () => {
      expect(() => new AlanaClient(configWith({}), metrics)).toThrow(
        'ALANA_CONTROL_URL is missing or invalid',
      );
      expect(
        () =>
          new AlanaClient(
            configWith({ ALANA_CONTROL_URL: 'http://alana:8080' }),
            metrics,
          ),
      ).toThrow('ALANA_CONTROL_TOKEN is missing or invalid');
    });

    it('rejects too short and too long tokens and accepts the bounds', () => {
      const withToken = (token: string) =>
        new AlanaClient(
          configWith({
            ALANA_CONTROL_URL: 'http://alana:8080',
            ALANA_CONTROL_TOKEN: token,
          }),
          metrics,
        );
      expect(() => withToken('a'.repeat(15))).toThrow(
        'ALANA_CONTROL_TOKEN is missing or invalid',
      );
      expect(() => withToken('a'.repeat(4097))).toThrow(
        'ALANA_CONTROL_TOKEN is missing or invalid',
      );
      expect(withToken('a'.repeat(16))).toBeInstanceOf(AlanaClient);
      expect(withToken('a'.repeat(4096))).toBeInstanceOf(AlanaClient);
    });
  });

  describe('requests', () => {
    it('GETs status without a body or content type', async () => {
      const fetchMock = jest
        .spyOn(global, 'fetch')
        .mockResolvedValue(Response.json({ requestedState: 'running' }));

      const state = await client().status('main/1');

      expect(state.requestedState).toBe('running');
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('http://alana.test:8080/v1/programs/main%2F1/lifecycle');
      expect(init?.method).toBe('GET');
      expect(init?.headers).toEqual({
        Authorization: 'Bearer fictional-alana-control-token',
      });
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect(recordDependency).toHaveBeenCalledWith(
        'alana',
        'status',
        'success',
        expect.any(Number),
      );
    });

    it('PUTs a reload with idempotency key and JSON body', async () => {
      const fetchMock = jest
        .spyOn(global, 'fetch')
        .mockResolvedValue(Response.json({}));

      await client().reload('main', 'cmd-1', selection);

      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe(
        'http://alana.test:8080/v1/programs/main/destinations/destinations-test-1',
      );
      expect(init?.method).toBe('PUT');
      expect(init?.body).toBe(
        JSON.stringify({ commandId: 'cmd-1', ...selection }),
      );
      expect(init?.headers).toEqual({
        Authorization: 'Bearer fictional-alana-control-token',
        'Content-Type': 'application/json',
        'Idempotency-Key': 'cmd-1',
      });
      expect(recordDependency).toHaveBeenCalledWith(
        'alana',
        'reload',
        'success',
        expect.any(Number),
      );
    });

    it('POSTs a stop with sequence header and no body', async () => {
      const fetchMock = jest
        .spyOn(global, 'fetch')
        .mockResolvedValue(Response.json({}));

      await client().stop('main', 'cmd-2', 12);

      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe(
        'http://alana.test:8080/v1/programs/main/lifecycle/stop',
      );
      expect(init?.method).toBe('POST');
      expect(init).not.toHaveProperty('body');
      expect(init?.headers).toEqual({
        Authorization: 'Bearer fictional-alana-control-token',
        'Idempotency-Key': 'cmd-2',
        'X-Command-Sequence': '12',
      });
    });

    it('maps non-ok responses to AlanaRequestError carrying the sanitized state', async () => {
      jest
        .spyOn(global, 'fetch')
        .mockResolvedValue(
          Response.json(
            { actualState: 'stopped', error: 'bad', secret: 'leak' },
            { status: 409 },
          ),
        );

      let thrown: unknown;
      try {
        await client().start('main', 'cmd-3', 1, selection);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(AlanaRequestError);
      const error = thrown as AlanaRequestError;
      expect(error.status).toBe(409);
      expect(error.state.actualState).toBe('stopped');
      expect(error.state.error).toBe('bad');
      expect(JSON.stringify(error.state)).not.toContain('leak');
      expect(recordDependency).toHaveBeenCalledWith(
        'alana',
        'start',
        'http-error',
        expect.any(Number),
      );
    });

    it('reports invalid JSON as a 502 with a fixed message', async () => {
      jest
        .spyOn(global, 'fetch')
        .mockResolvedValue(new Response('<html>', { status: 200 }));

      await expect(client().status('main')).rejects.toMatchObject({
        status: 502,
        message: 'Alana returned an invalid response',
      });
    });

    it('reports transport failures as a 503 without leaking the cause', async () => {
      jest
        .spyOn(global, 'fetch')
        .mockRejectedValue(new Error('ECONNREFUSED 10.0.0.1'));

      let thrown: unknown;
      try {
        await client().stop('main', 'cmd-4', 2);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(AlanaRequestError);
      expect((thrown as AlanaRequestError).status).toBe(503);
      expect((thrown as AlanaRequestError).message).toBe(
        'Alana is unavailable',
      );
      expect(recordDependency).toHaveBeenCalledWith(
        'alana',
        'stop',
        'unavailable',
        expect.any(Number),
      );
    });
  });

  describe('sanitizeAlanaState', () => {
    it.each([null, undefined, 'x', 3, []])(
      'returns a safe default state for %p',
      (value) => {
        expect(sanitizeAlanaState(value)).toEqual({
          requestedState: 'unknown',
          actualState: 'unknown',
          transition: null,
          readiness: false,
          lastSequence: 0,
          activeDestinations: null,
          pendingDestinations: null,
          destinations: [],
          commandResult: null,
        });
      },
    );

    it('keeps bounded scalar fields and drops oversized or mistyped ones', () => {
      const state = sanitizeAlanaState({
        requestedState: 'running',
        actualState: 'x'.repeat(201),
        transition: 'starting',
        readiness: true,
        lastSequence: 7.9,
      });
      expect(state).toMatchObject({
        requestedState: 'running',
        actualState: 'unknown',
        transition: 'starting',
        readiness: true,
        lastSequence: 7,
      });
      expect(
        sanitizeAlanaState({ lastSequence: -1, readiness: 'yes' }),
      ).toMatchObject({ lastSequence: 0, readiness: false });
      expect(sanitizeAlanaState({ transition: 4 }).transition).toBeNull();
      expect(sanitizeAlanaState({ lastSequence: '3' }).lastSequence).toBe(0);
    });

    it('sanitizes the error with a bounded fallback', () => {
      expect(sanitizeAlanaState({ error: 'oops' }).error).toBe('oops');
      expect(sanitizeAlanaState({ error: 'x'.repeat(201) }).error).toBe(
        'downstream request failed',
      );
      expect(sanitizeAlanaState({ error: 5 })).not.toHaveProperty('error');
    });

    it('accepts well formed destination metadata and filters ids', () => {
      const metadata = {
        version: 'v1',
        selectionHash: HASH,
        count: 2,
        destinationIds: ['a', 'b', 7, 'z'.repeat(65)],
        secretId: 'leak',
      };
      // Two valid ids plus two filtered ones matches count 2.
      expect(
        sanitizeAlanaState({ activeDestinations: metadata }),
      ).toMatchObject({
        activeDestinations: {
          version: 'v1',
          selectionHash: HASH,
          count: 2,
          destinationIds: ['a', 'b'],
        },
      });
      expect(
        sanitizeAlanaState({ activeDestinations: metadata }).activeDestinations,
      ).not.toHaveProperty('secretId');
    });

    it.each([
      ['null', null],
      ['array', []],
      ['string', 'x'],
      [
        'non string version',
        { version: 1, selectionHash: HASH, count: 1, destinationIds: ['a'] },
      ],
      [
        'non string hash',
        { version: 'v', selectionHash: 1, count: 1, destinationIds: ['a'] },
      ],
      [
        'malformed hash',
        { version: 'v', selectionHash: 'zz', count: 1, destinationIds: ['a'] },
      ],
      [
        'non numeric count',
        {
          version: 'v',
          selectionHash: HASH,
          count: '1',
          destinationIds: ['a'],
        },
      ],
      [
        'count below 1',
        { version: 'v', selectionHash: HASH, count: 0, destinationIds: [] },
      ],
      [
        'count above 20',
        {
          version: 'v',
          selectionHash: HASH,
          count: 21,
          destinationIds: Array.from({ length: 21 }, (_, i) => `d${i}`),
        },
      ],
      [
        'id count mismatch',
        { version: 'v', selectionHash: HASH, count: 2, destinationIds: ['a'] },
      ],
      ['missing ids array', { version: 'v', selectionHash: HASH, count: 1 }],
    ])('rejects destination metadata with %s', (_name, activeDestinations) => {
      expect(
        sanitizeAlanaState({ activeDestinations }).activeDestinations,
      ).toBeNull();
    });

    it('falls back to the top level record for pending destinations', () => {
      const flat = {
        version: 'v2',
        selectionHash: HASH,
        count: 1,
        destinationIds: ['a'],
      };
      expect(sanitizeAlanaState(flat).pendingDestinations).toMatchObject({
        version: 'v2',
        count: 1,
      });
      expect(
        sanitizeAlanaState({
          pendingDestinations: { ...flat, version: 'nested' },
          ...flat,
        }).pendingDestinations?.version,
      ).toBe('nested');
    });

    it('sanitizes the acknowledgement destinations', () => {
      const entries = [
        {
          id: 'ok',
          mode: 'relaying',
          supervisorHealthy: true,
          publisherProcessHealthy: false,
          url: 'rtmps://leak',
        },
        { id: 'defaults', mode: 'm'.repeat(201) },
        null,
        [],
        { id: 5 },
        { id: 'i'.repeat(65) },
      ];
      const state = sanitizeAlanaState({
        croccanteAcknowledgement: { destinations: entries },
      });
      expect(state.destinations).toEqual([
        {
          id: 'ok',
          mode: 'relaying',
          supervisorHealthy: true,
          publisherProcessHealthy: false,
        },
        {
          id: 'defaults',
          mode: 'unknown',
          supervisorHealthy: false,
          publisherProcessHealthy: false,
        },
      ]);
    });

    it('caps destination states at 20 and ignores non-array values', () => {
      const many = Array.from({ length: 25 }, (_, index) => ({
        id: `d${index}`,
      }));
      expect(
        sanitizeAlanaState({ croccanteAcknowledgement: { destinations: many } })
          .destinations,
      ).toHaveLength(20);
      expect(
        sanitizeAlanaState({
          croccanteAcknowledgement: { destinations: 'nope' },
        }).destinations,
      ).toEqual([]);
      expect(
        sanitizeAlanaState({ croccanteAcknowledgement: [] }).destinations,
      ).toEqual([]);
      expect(
        sanitizeAlanaState({ croccanteAcknowledgement: 'x' }).destinations,
      ).toEqual([]);
    });

    it('sanitizes command results including optional fields', () => {
      expect(
        sanitizeAlanaState({
          commandResult: {
            action: 'start',
            result: 'accepted',
            status: 202,
            sequence: 4,
            destinationVersion: 'v1',
            destinationSelectionHash: HASH,
            destinationCount: 2,
            extra: 'leak',
          },
        }).commandResult,
      ).toEqual({
        action: 'start',
        result: 'accepted',
        status: 202,
        sequence: 4,
        destinationVersion: 'v1',
        destinationSelectionHash: HASH,
        destinationCount: 2,
      });
      expect(
        sanitizeAlanaState({ commandResult: { action: 1, status: 'x' } })
          .commandResult,
      ).toEqual({
        action: 'unknown',
        result: 'unknown',
        status: 0,
        sequence: 0,
      });
      expect(
        sanitizeAlanaState({ commandResult: [] }).commandResult,
      ).toBeNull();
      expect(
        sanitizeAlanaState({ commandResult: 'x' }).commandResult,
      ).toBeNull();
    });
  });

  describe('normalizeAlanaBaseUrl', () => {
    it('returns the origin for valid http and https roots', () => {
      expect(normalizeAlanaBaseUrl('http://alana:8080')).toBe(
        'http://alana:8080',
      );
      expect(normalizeAlanaBaseUrl('https://alana.example/')).toBe(
        'https://alana.example',
      );
    });

    it.each([
      '',
      'not a url',
      'ftp://alana',
      'http://user@alana',
      'http://:pass@alana',
      'http://alana/?q=1',
      'http://alana/#frag',
      'http://alana/path',
    ])('rejects %p', (value) => {
      expect(() => normalizeAlanaBaseUrl(value)).toThrow(
        'ALANA_CONTROL_URL is missing or invalid',
      );
    });
  });

  it('falls back to Object paramtypes when collaborators are undefined at decoration time', () => {
    jest.isolateModules(() => {
      jest.doMock('@nestjs/config', () => ({ ConfigService: undefined }));
      jest.doMock('../observability/managed-metrics.service', () => ({
        ManagedMetricsService: undefined,
      }));
      const { AlanaClient: Isolated } = require('./alana.client') as {
        AlanaClient: new (...args: never[]) => unknown;
      };
      expect(Reflect.getMetadata('design:paramtypes', Isolated)).toEqual([
        Object,
        Object,
      ]);
    });
    jest.resetModules();
  });
});
