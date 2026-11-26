import { BadGatewayException, ConflictException, Logger } from '@nestjs/common';
import { BroadcastDestinationsService } from './broadcast-destinations.service';
import {
  DestinationSecretsService,
  RETIRED_SECRET_RECOVERY_DAYS,
} from './destination-secrets.service';

// gaulatti/alcantara#384: retiring a destination schedules the deletion of the key this application wrote, with a
// recovery window; restoring cancels it. A secret this application did not write is never touched.
const OURS =
  'arn:aws:secretsmanager:us-east-1:1:secret:alcantara/destinations/7/d1-AbC';

function build(
  secretId: string | null,
  sharing = 0,
  retiredAt: Date | null = null,
) {
  const row = { id: 'd1', secretId, retiredAt };
  const prisma = {
    broadcastDestination: {
      findUnique: jest.fn().mockResolvedValue(row),
      update: jest.fn().mockResolvedValue(row),
      count: jest.fn().mockResolvedValue(sharing),
    },
  };
  const metrics = { recordBroadcastDestination: jest.fn() };
  const secrets = {
    scheduleDeletion: jest.fn().mockResolvedValue(undefined),
    cancelDeletion: jest.fn().mockResolvedValue('kept'),
  };
  const service = new BroadcastDestinationsService(
    prisma as never,
    {} as never,
    metrics as never,
    {} as never,
    secrets as never,
  );
  return { service, prisma, metrics, secrets };
}

describe('retiring and restoring a destination and its secret', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('schedules the deletion on retire, after the row is retired, and counts it', async () => {
    const f = build(OURS);
    await f.service.setRetired('d1', true);
    expect(f.secrets.scheduleDeletion).toHaveBeenCalledWith(OURS);
    expect(f.metrics.recordBroadcastDestination).toHaveBeenCalledWith(
      'retire_secret',
      'succeeded',
    );
    expect(f.prisma.broadcastDestination.count).toHaveBeenCalledWith({
      where: { secretId: OURS, retiredAt: null },
    });
  });

  it('keeps a secret another active destination uses, and one this application did not write', async () => {
    const shared = build(OURS, 1);
    await shared.service.setRetired('d1', true);
    expect(shared.secrets.scheduleDeletion).not.toHaveBeenCalled();
    for (const foreign of ['broadcast/youtube/key', null]) {
      const f = build(foreign);
      await f.service.setRetired('d1', true);
      f.prisma.broadcastDestination.findUnique.mockResolvedValue({
        id: 'd1',
        secretId: foreign,
        retiredAt: new Date(),
      });
      await f.service.setRetired('d1', false);
      expect(f.secrets.scheduleDeletion).not.toHaveBeenCalled();
      expect(f.secrets.cancelDeletion).not.toHaveBeenCalled();
    }
  });

  it('lets the retire stand when the provider refuses, and says nothing about the secret', async () => {
    const f = build(OURS);
    f.secrets.scheduleDeletion.mockRejectedValue(new Error(`denied ${OURS}`));
    await expect(f.service.setRetired('d1', true)).resolves.toBeTruthy();
    expect(f.metrics.recordBroadcastDestination).toHaveBeenCalledWith(
      'retire_secret',
      'failed',
    );
    expect(
      JSON.stringify((Logger.prototype.warn as jest.Mock).mock.calls),
    ).not.toContain('alcantara/destinations');
  });

  it('touches no secret when a retire or restore repeats the state the destination is in', async () => {
    const retired = build(OURS, 0, new Date());
    await retired.service.setRetired('d1', true);
    const active = build(OURS);
    await active.service.setRetired('d1', false);
    for (const f of [retired, active]) {
      expect(f.secrets.scheduleDeletion).not.toHaveBeenCalled();
      expect(f.secrets.cancelDeletion).not.toHaveBeenCalled();
    }
  });

  it('cancels the deletion before restoring the row', async () => {
    const f = build(OURS, 0, new Date());
    const order: string[] = [];
    f.secrets.cancelDeletion.mockImplementation(async () => {
      order.push('cancel');
      return 'kept';
    });
    f.prisma.broadcastDestination.update.mockImplementation(async () => {
      order.push('update');
      return { secretId: OURS };
    });
    await f.service.setRetired('d1', false);
    expect(order).toEqual(['cancel', 'update']);
    expect(f.secrets.scheduleDeletion).not.toHaveBeenCalled();
  });

  it('refuses to restore when the key is gone, and when it cannot be brought back, leaving the row retired', async () => {
    const gone = build(OURS, 0, new Date());
    gone.secrets.cancelDeletion.mockResolvedValue('gone');
    await expect(gone.service.setRetired('d1', false)).rejects.toBeInstanceOf(
      ConflictException,
    );
    const down = build(OURS, 0, new Date());
    down.secrets.cancelDeletion.mockRejectedValue(new Error('down'));
    await expect(down.service.setRetired('d1', false)).rejects.toBeInstanceOf(
      BadGatewayException,
    );
    for (const f of [gone, down])
      expect(f.prisma.broadcastDestination.update).not.toHaveBeenCalled();
  });
});

describe('DestinationSecretsService retirement', () => {
  function secrets(send: jest.Mock) {
    const service = new DestinationSecretsService();
    service.client = { send };
    return service;
  }

  it('owns names and ARNs under its prefix only', () => {
    expect(DestinationSecretsService.owns(OURS)).toBe(true);
    expect(DestinationSecretsService.owns('alcantara/destinations/1/x')).toBe(
      true,
    );
    expect(DestinationSecretsService.owns('broadcast/production/config')).toBe(
      false,
    );
    expect(
      DestinationSecretsService.owns(
        'arn:aws:secretsmanager:us-east-1:1:secret:other/alcantara/destinations/1',
      ),
    ).toBe(false);
  });

  it('schedules deletion with the recovery window, never a forced delete', async () => {
    const send = jest.fn().mockResolvedValue({});
    await secrets(send).scheduleDeletion(OURS);
    expect(send.mock.calls[0][0].input).toEqual({
      SecretId: OURS,
      RecoveryWindowInDays: RETIRED_SECRET_RECOVERY_DAYS,
    });
    expect(RETIRED_SECRET_RECOVERY_DAYS).toBe(30);
  });

  it('restores, reports a secret past its window as gone and passes other errors on', async () => {
    const ok = jest.fn().mockResolvedValue({});
    await expect(secrets(ok).cancelDeletion(OURS)).resolves.toBe('kept');
    expect(ok.mock.calls[0][0].input).toEqual({ SecretId: OURS });
    const gone = jest
      .fn()
      .mockRejectedValue(
        Object.assign(new Error('x'), { name: 'ResourceNotFoundException' }),
      );
    await expect(secrets(gone).cancelDeletion(OURS)).resolves.toBe('gone');
    const denied = jest.fn().mockRejectedValue(new Error('denied'));
    await expect(secrets(denied).cancelDeletion(OURS)).rejects.toThrow(
      'denied',
    );
  });
});
