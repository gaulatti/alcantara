import {
  NotFoundException,
  ServiceUnavailableException,
  Logger,
} from '@nestjs/common';
import { BroadcastDestinationsService } from './broadcast-destinations.service';

// gaulatti/alcantara#384: retiring a destination schedules its own secret for deletion with a
// recovery window, and restoring cancels that first, so a selectable destination never points at
// a secret about to be deleted. Hand-typed secret references are never touched.

const OWNED =
  'arn:aws:secretsmanager:us-east-1:123456789012:secret:alcantara/destinations/7/yt-AbCdEf';
const row = (overrides: Record<string, unknown> = {}) => ({
  id: 'yt',
  service: 'youtube',
  secretId: OWNED,
  retiredAt: null as Date | null,
  ...overrides,
});

function setup(existing: ReturnType<typeof row> | null) {
  const order: string[] = [];
  const prisma = {
    broadcastDestination: {
      findUnique: jest.fn().mockResolvedValue(existing),
      update: jest.fn(({ data }: { data: Record<string, unknown> }) => {
        order.push('update');
        return Promise.resolve({ ...existing, ...data });
      }),
    },
  };
  const secrets = {
    scheduleDeletion: jest.fn(() => {
      order.push('schedule');
      return Promise.resolve();
    }),
    cancelDeletion: jest.fn(() => {
      order.push('cancel');
      return Promise.resolve();
    }),
  };
  const metrics = { recordBroadcastDestination: jest.fn() };
  const service = new BroadcastDestinationsService(
    prisma as never,
    {} as never,
    metrics as never,
    {} as never,
    secrets as never,
  );
  const warn = jest
    .spyOn(Logger.prototype, 'warn')
    .mockImplementation(() => undefined);
  return { service, prisma, secrets, metrics, order, warn };
}

describe('retiring and restoring a destination and its secret', () => {
  afterEach(() => jest.restoreAllMocks());

  it('retires first, then schedules the owned secret for deletion', async () => {
    const t = setup(row());
    const result = await t.service.setRetired('yt', true);
    expect(t.order).toEqual(['update', 'schedule']);
    expect(t.secrets.scheduleDeletion).toHaveBeenCalledWith(OWNED);
    expect(result.retiredAt).toBeInstanceOf(Date);
    expect(t.metrics.recordBroadcastDestination).toHaveBeenCalledWith(
      'retire_secret',
      'succeeded',
    );
  });

  it('keeps the retire when the deletion cannot be scheduled, and says so', async () => {
    const t = setup(row());
    t.secrets.scheduleDeletion.mockRejectedValueOnce(new Error('AccessDenied'));
    await expect(t.service.setRetired('yt', true)).resolves.toMatchObject({
      id: 'yt',
    });
    expect(t.metrics.recordBroadcastDestination).toHaveBeenCalledWith(
      'retire_secret',
      'failed',
    );
    expect(t.warn).toHaveBeenCalledWith(
      'Destination yt was retired, but its key could not be scheduled for deletion; it stays in Secrets Manager',
    );
  });

  it('cancels the deletion before restoring the row', async () => {
    const t = setup(row({ retiredAt: new Date('2026-11-01T00:00:00Z') }));
    const result = await t.service.setRetired('yt', false);
    expect(t.order).toEqual(['cancel', 'update']);
    expect(result.retiredAt).toBeNull();
    expect(t.metrics.recordBroadcastDestination).toHaveBeenCalledWith(
      'restore_secret',
      'succeeded',
    );
  });

  it('refuses the restore and leaves the row retired when the deletion cannot be cancelled', async () => {
    const t = setup(row({ retiredAt: new Date('2026-11-01T00:00:00Z') }));
    t.secrets.cancelDeletion.mockRejectedValueOnce(new Error('AccessDenied'));
    await expect(t.service.setRetired('yt', false)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(t.prisma.broadcastDestination.update).not.toHaveBeenCalled();
    expect(t.metrics.recordBroadcastDestination).toHaveBeenCalledWith(
      'restore_secret',
      'failed',
    );
  });

  it('never touches a hand-typed secret reference or a secret outside its own prefix', async () => {
    for (const existing of [
      row({ service: null }),
      row({ secretId: 'broadcast/production/youtube' }),
    ]) {
      const t = setup(existing);
      await t.service.setRetired('yt', true);
      t.prisma.broadcastDestination.findUnique.mockResolvedValue({
        ...existing,
        retiredAt: new Date(),
      });
      await t.service.setRetired('yt', false);
      expect(t.secrets.scheduleDeletion).not.toHaveBeenCalled();
      expect(t.secrets.cancelDeletion).not.toHaveBeenCalled();
      expect(t.metrics.recordBroadcastDestination).not.toHaveBeenCalled();
      jest.restoreAllMocks();
    }
  });

  it('a repeated retire or restore calls Secrets Manager no more and keeps the first retire time', async () => {
    const first = new Date('2026-11-01T00:00:00Z');
    const retired = setup(row({ retiredAt: first }));
    const again = await retired.service.setRetired('yt', true);
    expect(again.retiredAt).toBe(first);
    expect(retired.secrets.scheduleDeletion).not.toHaveBeenCalled();
    jest.restoreAllMocks();

    const active = setup(row());
    await active.service.setRetired('yt', false);
    expect(active.secrets.cancelDeletion).not.toHaveBeenCalled();
  });

  it('answers not found for a destination that does not exist, and calls nothing', async () => {
    const t = setup(null);
    await expect(t.service.setRetired('yt', true)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(t.prisma.broadcastDestination.update).not.toHaveBeenCalled();
    expect(t.secrets.scheduleDeletion).not.toHaveBeenCalled();
  });
});
