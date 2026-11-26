import { Logger } from '@nestjs/common';
import type { ManagedMetricsService } from '../observability/managed-metrics.service';
import type { PrismaService } from '../prisma.service';

const logger = new Logger('FillerRelease');

/**
 * A stopped session no longer holds its filler: the leg's active version goes back to pending, unless a newer one is
 * already pending, so the next Start binds to the same filler. While a version is active the filler counts as on air.
 *
 * Best effort: the Stop has already taken effect, so a failed write is logged and counted and never fails it. The
 * version then stays active until the next Stop.
 */
export async function releaseActiveFiller(
  prisma: PrismaService,
  programId: string,
  leg: 'radio' | 'television',
  metrics?: ManagedMetricsService,
): Promise<void> {
  try {
    const row = await prisma.fillerLeg.findUnique({
      where: { programId_leg: { programId, leg } },
    });
    if (!row?.activeVersionId) return;
    // Written only while the leg is as it was read: a preparation or a Start in between keeps what it wrote.
    await prisma.fillerLeg.updateMany({
      where: {
        programId,
        leg,
        activeVersionId: row.activeVersionId,
        pendingVersionId: row.pendingVersionId,
      },
      data: {
        activeVersionId: null,
        pendingVersionId: row.pendingVersionId ?? row.activeVersionId,
      },
    });
    metrics?.recordFillerRelease(leg, 'released');
  } catch (error) {
    metrics?.recordFillerRelease(leg, 'failed');
    logger.warn(
      `The ${leg} filler of ${programId} was not released after Stop (${error instanceof Error ? error.name : 'unknown'})`,
    );
  }
}
