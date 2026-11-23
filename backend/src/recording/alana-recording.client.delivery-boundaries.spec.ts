import { ConfigService } from '@nestjs/config';
import { ManagedMetricsService } from '../observability/managed-metrics.service';
import { AlanaRecordingClient } from './alana-recording.client';

describe('recording default platform transport', () => {
  afterEach(() => jest.restoreAllMocks());
  it('uses global fetch when no transport is injected and keeps credentials in the private request header', async () => {
    const transport = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(Response.json({ enabled: true, state: 'idle' }));
    const token = 'a'.repeat(64);
    const client = new AlanaRecordingClient(
      new ConfigService({
        NODE_ENV: 'test',
        ALANA_CONTROL_URL: 'http://alana:8080',
        ALANA_CONTROL_TOKEN: token,
      }),
      new ManagedMetricsService(),
    );
    await expect(client.status('radio / one')).resolves.toMatchObject({
      enabled: true,
      state: 'idle',
    });
    expect(transport).toHaveBeenCalledWith(
      'http://alana:8080/v1/programs/radio%20%2F%20one/recording',
      expect.objectContaining({
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
      }),
    );
    expect(transport.mock.calls[0][0]).not.toContain(token);
  });
});
