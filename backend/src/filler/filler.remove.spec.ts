/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access -- Prisma doubles are untyped */
import { BadRequestException } from '@nestjs/common';
import { ALCANTARA_PERMISSIONS } from '../auth/permissions';
import { REQUIRED_PERMISSION_KEY } from '../auth/require-permission.decorator';
import { ManagedMetricsService } from '../observability/managed-metrics.service';
import { FillerController } from './filler.controller';
import { FillerService } from './filler.service';

// gaulatti/alcantara#20: a configured radio filler can be taken away again, so configuring it is not one way.
function build(type: string, count: number) {
  const prisma: any = {
    programState: { findUnique: jest.fn().mockResolvedValue({ type }) },
    fillerLeg: {
      updateMany: jest.fn().mockResolvedValue({ count }),
      findMany: jest.fn().mockResolvedValue([]),
    },
    fillerVersion: { findMany: jest.fn().mockResolvedValue([]) },
  };
  const metrics = new ManagedMetricsService();
  const removal = jest.spyOn(metrics, 'recordFillerRemoval');
  const service = new FillerService(
    prisma,
    {} as never,
    {} as never,
    {} as never,
    metrics,
    { teamId: 0 } as never,
  );
  return { prisma, service, removal, metrics };
}

describe('removing the radio filler', () => {
  it('clears the leg only, keeping the versions, and counts it', async () => {
    const h = build('radio', 1);
    await expect(h.service.removeRadio('fm')).resolves.toMatchObject({
      programId: 'fm',
      legs: { radio: { pending: null, active: null } },
    });
    expect(h.prisma.fillerLeg.updateMany).toHaveBeenCalledWith({
      where: {
        programId: 'fm',
        leg: 'radio',
        OR: [
          { pendingVersionId: { not: null } },
          { activeVersionId: { not: null } },
        ],
      },
      data: { pendingVersionId: null, activeVersionId: null },
    });
    expect(h.removal).toHaveBeenCalledWith('radio');
    await expect(h.metrics.registry.metrics()).resolves.toContain(
      'alcantara_filler_removals_total{leg="radio"} 1',
    );
  });

  it('does nothing, and counts nothing, when there is none', async () => {
    const h = build('both', 0);
    await h.service.removeRadio('fm');
    expect(h.removal).not.toHaveBeenCalled();
  });

  it('refuses a program with no radio leg', async () => {
    const h = build('tv', 0);
    await expect(h.service.removeRadio('tv')).rejects.toThrow(
      BadRequestException,
    );
    expect(h.prisma.fillerLeg.updateMany).not.toHaveBeenCalled();
  });

  it('needs the permission that configures a filler', async () => {
    const remove = jest.fn().mockResolvedValue('state');
    const controller = new FillerController({ removeRadio: remove } as never);
    await expect(controller.removeRadio('fm')).resolves.toBe('state');
    expect(
      Reflect.getMetadata(
        REQUIRED_PERMISSION_KEY,
        FillerController.prototype.removeRadio,
      ),
    ).toBe(ALCANTARA_PERMISSIONS.broadcast.manage);
  });
});
