/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { ConfigService } from '@nestjs/config';
import { ManagedMetricsService } from '../observability/managed-metrics.service';
import { AlanaClient, AlanaRequestError } from './alana.client';

const selection = {
  version: 'destinations-test-1',
  destinations: [
    {
      id: 'primary',
      secretId: 'broadcast/test/primary',
      versionId: 'version-1',
    },
  ],
};

describe('AlanaClient', () => {
  const recordDependency = jest.fn();

  beforeEach(() => {
    jest.restoreAllMocks();
    recordDependency.mockReset();
  });

  function client() {
    return new AlanaClient(
      {
        get: jest.fn(
          (key: string) =>
            ({
              NODE_ENV: 'test',
              ALANA_CONTROL_URL: 'http://alana.test:8080',
              ALANA_CONTROL_TOKEN: 'fictional-alana-control-token',
            })[key],
        ),
      } as unknown as ConfigService,
      { recordDependency } as unknown as ManagedMetricsService,
    );
  }

  it('sends the exact selection to Alana and returns only bounded state', async () => {
    const response = {
      requestedState: 'running',
      actualState: 'running',
      readiness: true,
      lastSequence: 9,
      activeDestinations: {
        version: selection.version,
        selectionHash: 'a'.repeat(64),
        count: 1,
        destinationIds: ['primary'],
        secretId: 'must-not-leak',
      },
      croccanteAcknowledgement: {
        accepted: true,
        destinations: [
          {
            id: 'primary',
            mode: 'relaying',
            supervisorHealthy: true,
            publisherProcessHealthy: true,
            url: 'rtmps://must-not-leak',
          },
        ],
      },
    };
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify(response), { status: 200 }),
      );

    const result = await client().start('main', 'command-1', 9, selection);

    expect(fetchMock).toHaveBeenCalledWith(
      'http://alana.test:8080/v1/programs/main/lifecycle/start',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify(selection),
        headers: expect.objectContaining({
          Authorization: 'Bearer fictional-alana-control-token',
          'Idempotency-Key': 'command-1',
          'X-Command-Sequence': '9',
        }),
      }),
    );
    expect(result.destinations).toEqual([
      {
        id: 'primary',
        mode: 'relaying',
        supervisorHealthy: true,
        publisherProcessHealthy: true,
      },
    ]);
    expect(JSON.stringify(result)).not.toContain('must-not-leak');
    expect(recordDependency).toHaveBeenCalledWith(
      'alana',
      'start',
      'success',
      expect.any(Number),
    );
  });

  it('fails closed on an invalid downstream response', async () => {
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response('not-json', { status: 200 }));

    await expect(client().status('main')).rejects.toBeInstanceOf(
      AlanaRequestError,
    );
    expect(recordDependency).toHaveBeenCalledWith(
      'alana',
      'status',
      'invalid-response',
      expect.any(Number),
    );
  });
});
