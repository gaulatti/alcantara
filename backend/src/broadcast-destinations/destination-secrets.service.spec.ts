/* eslint-disable @typescript-eslint/no-unsafe-return */
import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import {
  DESTINATION_SECRET_PREFIX,
  DESTINATION_SECRET_RECOVERY_DAYS,
  DestinationSecretsService,
  type DestinationSecretClient,
} from './destination-secrets.service';

const mockSend = jest.fn();
jest.mock('@aws-sdk/client-secrets-manager', () => ({
  ...jest.requireActual('@aws-sdk/client-secrets-manager'),
  SecretsManagerClient: jest.fn(() => ({ send: mockSend })),
}));

const payload = {
  scheme: 'rtmps' as const,
  host: 'a.rtmps.youtube.com',
  port: 443,
  application: 'live2',
  streamKey: 'live_abcd-1234',
};

describe('DestinationSecretsService', () => {
  beforeEach(() => mockSend.mockReset());

  it('names secrets under the fixed prefix, per team and destination', () => {
    expect(DestinationSecretsService.nameFor(7, 'youtube')).toBe(
      `${DESTINATION_SECRET_PREFIX}/7/youtube`,
    );
  });

  it('creates a secret with exactly the payload and returns its ARN and version', async () => {
    const service = new DestinationSecretsService();
    const send = jest
      .fn()
      .mockResolvedValue({ ARN: 'arn:aws:secretsmanager:x', VersionId: 'v1' });
    service.client = { send } as unknown as DestinationSecretClient;
    await expect(
      service.create('alcantara/destinations/7/youtube', payload),
    ).resolves.toEqual({
      secretId: 'arn:aws:secretsmanager:x',
      versionId: 'v1',
    });
    const input = (
      send.mock.calls[0] as [{ input: Record<string, unknown> }]
    )[0].input;
    expect(input.Name).toBe('alcantara/destinations/7/youtube');
    expect(JSON.parse(input.SecretString as string)).toEqual(payload);
  });

  it('refuses a create or put the provider did not complete', async () => {
    const service = new DestinationSecretsService();
    service.client = {
      send: jest.fn().mockResolvedValue({}),
    } as unknown as DestinationSecretClient;
    await expect(service.create('n', payload)).rejects.toThrow(
      'secret not created',
    );
    await expect(service.put('arn', payload)).rejects.toThrow(
      'secret not written',
    );
  });

  it('puts a new version and returns its id', async () => {
    const service = new DestinationSecretsService();
    const send = jest.fn().mockResolvedValue({ VersionId: 'v2' });
    service.client = { send } as unknown as DestinationSecretClient;
    await expect(service.put('arn:x', payload)).resolves.toBe('v2');
    expect(
      (send.mock.calls[0] as [{ input: { SecretId: string } }])[0].input
        .SecretId,
    ).toBe('arn:x');
  });

  it('discards a secret without a recovery window', async () => {
    const service = new DestinationSecretsService();
    const send = jest.fn().mockResolvedValue({});
    service.client = { send } as unknown as DestinationSecretClient;
    await service.discard('arn:x');
    expect(
      (send.mock.calls[0] as [{ input: Record<string, unknown> }])[0].input,
    ).toEqual({ SecretId: 'arn:x', ForceDeleteWithoutRecovery: true });
  });

  it('owns only secrets under its own prefix, by name or by ARN (#384)', () => {
    expect(
      DestinationSecretsService.ownsSecret('alcantara/destinations/7/yt'),
    ).toBe(true);
    expect(
      DestinationSecretsService.ownsSecret(
        'arn:aws:secretsmanager:us-east-1:123456789012:secret:alcantara/destinations/7/yt-AbCdEf',
      ),
    ).toBe(true);
    expect(
      DestinationSecretsService.ownsSecret('broadcast/production/youtube'),
    ).toBe(false);
    expect(
      DestinationSecretsService.ownsSecret(
        'arn:aws:secretsmanager:us-east-1:123456789012:secret:broadcast/youtube-AbCdEf',
      ),
    ).toBe(false);
    expect(
      DestinationSecretsService.ownsSecret('alcantara/destinations-other/7'),
    ).toBe(false);
  });

  it('schedules a deletion with the recovery window, and cancels it with a restore (#384)', async () => {
    const service = new DestinationSecretsService();
    const send = jest.fn().mockResolvedValue({});
    service.client = { send } as DestinationSecretClient;
    await service.scheduleDeletion('alcantara/destinations/7/yt');
    await service.cancelDeletion('alcantara/destinations/7/yt');
    expect(DESTINATION_SECRET_RECOVERY_DAYS).toBe(30);
    expect(send.mock.calls[0][0].constructor.name).toBe('DeleteSecretCommand');
    expect(send.mock.calls[0][0].input).toEqual({
      SecretId: 'alcantara/destinations/7/yt',
      RecoveryWindowInDays: 30,
    });
    expect(send.mock.calls[1][0].constructor.name).toBe('RestoreSecretCommand');
    expect(send.mock.calls[1][0].input).toEqual({
      SecretId: 'alcantara/destinations/7/yt',
    });
  });

  it('builds the Secrets Manager client on first use and reuses it', async () => {
    mockSend.mockResolvedValue({ VersionId: 'v3' });
    const service = new DestinationSecretsService();
    await service.put('arn:x', payload);
    await service.put('arn:x', payload);
    expect(SecretsManagerClient).toHaveBeenCalledTimes(1);
    expect(mockSend).toHaveBeenCalledTimes(2);
  });
});
