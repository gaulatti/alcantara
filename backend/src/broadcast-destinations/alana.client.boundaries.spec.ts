import { ConfigService } from '@nestjs/config';
import {
  AlanaClient,
  AlanaRequestError,
  normalizeAlanaBaseUrl,
  sanitizeAlanaState,
} from './alana.client';
import type { ManagedMetricsService } from '../observability/managed-metrics.service';

const metadata = {
  version: 'version',
  selectionHash: 'a'.repeat(64),
  count: 1,
  destinationIds: ['primary'],
};
describe('bounded Alana state and private transport failure contracts', () => {
  afterEach(() => jest.restoreAllMocks());
  function fixture(values: Record<string, string | undefined> = {}) {
    const configuration = {
      ALANA_CONTROL_URL: 'http://alana.fixture:8080',
      ALANA_CONTROL_TOKEN: 'fixture-only-control-token',
      ...values,
    };
    const config = {
      get: (key: string) => configuration[key],
    } as unknown as ConfigService;
    const metrics = { recordDependency: jest.fn() };
    return {
      client: new AlanaClient(
        config,
        metrics as unknown as ManagedMetricsService,
      ),
      metrics,
    };
  }

  it.each([
    '',
    'not a url',
    'ftp://alana.fixture',
    'https://user@alana.fixture',
    'https://user:password@alana.fixture',
    'https://alana.fixture/path',
    'https://alana.fixture?key=value',
    'https://alana.fixture#fragment',
  ])('rejects non-origin private control configuration %s', (value) => {
    expect(() => normalizeAlanaBaseUrl(value)).toThrow(
      'ALANA_CONTROL_URL is missing or invalid',
    );
  });

  it.each(['', 'short', 'x'.repeat(4097)])(
    'requires a bounded configured control token (%#)',
    (token) => {
      expect(() => fixture({ ALANA_CONTROL_TOKEN: token })).toThrow(
        'ALANA_CONTROL_TOKEN is missing or invalid',
      );
    },
  );

  it('does not silently supply test settings in the default development environment', () => {
    expect(() =>
      fixture({ ALANA_CONTROL_URL: undefined, ALANA_CONTROL_TOKEN: undefined }),
    ).toThrow('ALANA_CONTROL_URL is missing or invalid');
    expect(() => fixture({ ALANA_CONTROL_TOKEN: undefined })).toThrow(
      'ALANA_CONTROL_TOKEN is missing or invalid',
    );
  });

  it('uses explicit test defaults only in test mode and keeps default-status requests bodyless', async () => {
    const fetcher = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(Response.json({}));
    const { client } = fixture({
      NODE_ENV: 'test',
      ALANA_CONTROL_URL: undefined,
      ALANA_CONTROL_TOKEN: undefined,
    });
    await client.status('program / one');
    expect(fetcher).toHaveBeenCalledWith(
      'http://alana.test:8080/v1/programs/program%20%2F%20one/lifecycle',
      expect.objectContaining({
        method: 'GET',
        headers: { Authorization: 'Bearer alana-test-control-token' },
      }),
    );
  });

  it.each([null, [], false, 'state', 4].map((value) => [value]))(
    'sanitizes non-record state input %j to safe defaults',
    (value) => {
      expect(sanitizeAlanaState(value)).toMatchObject({
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

  it.each([
    { version: 4 },
    { selectionHash: 'not-a-hash' },
    { count: 0 },
    { count: 21 },
    { count: 2 },
    { count: '1' },
    { destinationIds: 'primary' },
    { destinationIds: [4] },
    { destinationIds: ['x'.repeat(65)] },
  ])(
    'rejects metadata whose immutable identity/count cannot be verified: %j',
    (override) => {
      const safe = sanitizeAlanaState({
        activeDestinations: { ...metadata, ...override },
      });
      expect(safe.activeDestinations).toBeNull();
    },
  );

  it('supports exact pending metadata at either protocol location without exposing secret references', () => {
    expect(
      sanitizeAlanaState({ ...metadata, secretId: 'must-not-appear' })
        .pendingDestinations,
    ).toEqual(metadata);
    expect(
      sanitizeAlanaState({ pendingDestinations: metadata }).pendingDestinations,
    ).toEqual(metadata);
    const result = sanitizeAlanaState({
      croccanteAcknowledgement: {
        destinations: [
          null,
          [],
          4,
          { id: 4 },
          { id: 'x'.repeat(65) },
          { id: 'primary', mode: [], secretId: 'must-not-appear' },
        ],
      },
    });
    expect(result.destinations).toEqual([
      {
        id: 'primary',
        mode: 'unknown',
        supervisorHealthy: false,
        publisherProcessHealthy: false,
      },
    ]);
    expect(JSON.stringify(result)).not.toContain('must-not-appear');
  });

  it('limits destination states to20 and strips command extras while retaining safe optional acknowledgement fields', () => {
    const result = sanitizeAlanaState({
      requestedState: 'x'.repeat(201),
      actualState: false,
      transition: 'starting',
      readiness: true,
      lastSequence: 2.9,
      error: 'x'.repeat(201),
      croccanteAcknowledgement: {
        destinations: Array.from({ length: 21 }, (_, index) => ({
          id: `destination-${index}`,
          mode: 'relaying',
          supervisorHealthy: true,
          publisherProcessHealthy: true,
        })),
      },
      commandResult: {
        action: 'start',
        result: 'accepted',
        status: 202,
        sequence: 2,
        destinationVersion: 'version',
        destinationSelectionHash: 'a'.repeat(64),
        destinationCount: 1,
        secret: 'must-not-appear',
      },
    });
    expect(result).toMatchObject({
      requestedState: 'unknown',
      actualState: 'unknown',
      transition: 'starting',
      readiness: true,
      lastSequence: 2,
      error: 'downstream request failed',
      commandResult: {
        action: 'start',
        result: 'accepted',
        status: 202,
        sequence: 2,
        destinationVersion: 'version',
        destinationSelectionHash: 'a'.repeat(64),
        destinationCount: 1,
      },
    });
    expect(result.destinations).toHaveLength(20);
    expect(JSON.stringify(result)).not.toContain('must-not-appear');
  });

  it('handles malformed acknowledgement/command objects and defaults invalid status/sequence fields', () => {
    expect(
      sanitizeAlanaState({ croccanteAcknowledgement: [], commandResult: [] }),
    ).toMatchObject({ destinations: [], commandResult: null });
    expect(
      sanitizeAlanaState({
        croccanteAcknowledgement: { destinations: {} },
        commandResult: {
          action: false,
          result: false,
          status: 'bad',
          sequence: 'bad',
        },
        lastSequence: -1,
      }),
    ).toMatchObject({
      destinations: [],
      commandResult: {
        action: 'unknown',
        result: 'unknown',
        status: 0,
        sequence: 0,
      },
      lastSequence: 0,
    });
  });

  it('maps HTTP rejection to its bounded state and records the distinct error result', async () => {
    jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        Response.json(
          { error: 'DESTINATION_REJECTED', secret: 'must-not-appear' },
          { status: 409 },
        ),
      );
    const { client, metrics } = fixture();
    await expect(client.stop('program', 'command', 4)).rejects.toMatchObject({
      status: 409,
      message: 'DESTINATION_REJECTED',
    });
    expect(metrics.recordDependency).toHaveBeenCalledWith(
      'alana',
      'stop',
      'http-error',
      expect.any(Number),
    );
    expect(new AlanaRequestError(500, sanitizeAlanaState({})).message).toBe(
      'Alana request failed with HTTP 500',
    );
  });

  it.each([
    new Error('private endpoint unavailable'),
    new DOMException('timed out', 'TimeoutError'),
  ])(
    'redacts network and timeout errors into unavailable status (%#)',
    async (failure) => {
      jest.spyOn(globalThis, 'fetch').mockRejectedValue(failure);
      const { client, metrics } = fixture();
      await expect(client.status('program')).rejects.toMatchObject({
        status: 503,
        message: 'Alana is unavailable',
        state: expect.objectContaining({ error: 'Alana is unavailable' }),
      });
      expect(metrics.recordDependency).toHaveBeenCalledWith(
        'alana',
        'status',
        'unavailable',
        expect.any(Number),
      );
    },
  );
});
