import type { ConfigService } from '@nestjs/config';
import { ManagedMetricsService } from '../observability/managed-metrics.service';
import { AlanaClient, liveProfileChecksum } from './alana.client';
import type { TelevisionLiveProfile } from './broadcast-destinations.types';

// gaulatti/ariston#217: a live profile with a key Alcantara does not know is
// read, counted and forwarded to Alana exactly as received, so the checksum
// Croccante acknowledges still binds the same profile.

const PROFILE: TelevisionLiveProfile = {
  width: 1280,
  height: 720,
  fps: 30,
  videoBitrate: '4500k',
  audioRate: 48000,
  audioChannels: 2,
  audioBitrate: '160k',
  gop: 60,
  loopSeconds: 30,
};

function client(metrics: ManagedMetricsService) {
  return new AlanaClient(
    {
      get: (key: string) =>
        ({
          NODE_ENV: 'test',
          ALANA_CONTROL_URL: 'http://alana.test:8080',
          ALANA_CONTROL_TOKEN: 'fictional-alana-control-token',
        })[key],
    } as unknown as ConfigService,
    metrics,
  );
}

async function unknownKeys(metrics: ManagedMetricsService): Promise<string> {
  const text = await metrics.registry.metrics();
  return (
    text
      .split('\n')
      .find((line) =>
        line.startsWith('alcantara_alana_live_profile_unknown_keys_total '),
      ) ?? ''
  );
}

describe('AlanaClient live profile with unknown keys', () => {
  afterEach(() => jest.restoreAllMocks());

  it('returns the profile as received, counts each unknown key and forwards it intact', async () => {
    const extended = { ...PROFILE, secretFutureKey: 'x', crf: 18 };
    const checksum = liveProfileChecksum(extended);
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(
        Response.json({
          contractVersion: 1,
          programId: 'main',
          profile: extended,
          checksum,
        }),
      )
      .mockResolvedValueOnce(Response.json({}));
    const metrics = new ManagedMetricsService();
    const alana = client(metrics);

    const live = await alana.liveProfile('main');
    expect(live).toEqual({ profile: extended, checksum });
    expect(await unknownKeys(metrics)).toBe(
      'alcantara_alana_live_profile_unknown_keys_total 2',
    );
    expect(await metrics.registry.metrics()).not.toContain('secretFutureKey');

    await alana.prepareFiller('main', 'tv-1', {
      source: { id: 'asset-1', sha256: 'a'.repeat(64), downloadUrl: 'u' },
      profile: live!.profile,
    });
    const [, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    const sent = JSON.parse(init.body as string) as {
      profile: Record<string, unknown>;
    };
    expect(sent.profile).toEqual(extended);
    expect(liveProfileChecksum(sent.profile as never)).toBe(checksum);
  });

  it('still answers 502 when the checksum does not cover the profile as received', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValueOnce(
      Response.json({
        contractVersion: 1,
        programId: 'main',
        profile: { ...PROFILE, crf: 18 },
        checksum: liveProfileChecksum(PROFILE),
      }),
    );
    const metrics = new ManagedMetricsService();
    await expect(client(metrics).liveProfile('main')).rejects.toMatchObject({
      status: 502,
    });
    expect(await unknownKeys(metrics)).toBe(
      'alcantara_alana_live_profile_unknown_keys_total 0',
    );
  });
});
