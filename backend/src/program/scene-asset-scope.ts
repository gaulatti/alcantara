import { Injectable, Logger } from '@nestjs/common';
import { PompeiiService } from '../auth/pompeii.service';
import {
  ManagedMetricsService,
  type SceneAssetScopeReason,
} from '../observability/managed-metrics.service';
import { PrismaService } from '../prisma.service';
import { forTeam } from '../tenancy/scoped-prisma';

/**
 * The media asset a scene's background audio take reads (gaulatti/alcantara#122). It is an on-air path, so scoping
 * never takes anything off air: it reads the program team's asset, and whatever the team cannot serve is read as
 * before (unscoped) and counted. Station team `0` stays unscoped.
 */
@Injectable()
export class SceneAssetScope {
  private readonly logger = new Logger(SceneAssetScope.name);
  private readonly reported = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly pompeii: PompeiiService,
    private readonly metrics: ManagedMetricsService,
  ) {}

  async read<T>(
    programId: string,
    query: (db: PrismaService) => Promise<T | null>,
  ): Promise<T | null> {
    if (this.pompeii.teamId === 0) return query(this.prisma);
    try {
      const program = await this.prisma.program.findUnique({
        where: { programId },
        select: { teamId: true },
      });
      const teamId = program?.teamId;
      if (!teamId || teamId <= 0) {
        this.refuse(programId, 'no-team');
        return query(this.prisma);
      }
      const own = await query(
        forTeam(this.prisma, teamId) as unknown as PrismaService,
      );
      if (own) return own;
    } catch {
      this.refuse(programId, 'lookup-failed');
      return query(this.prisma);
    }
    const any = await query(this.prisma);
    if (any) this.refuse(programId, 'other-team');
    return any;
  }

  private refuse(programId: string, reason: SceneAssetScopeReason): void {
    this.metrics.recordSceneAssetScopeRefusal(reason);
    const key = `${reason}|${programId}`;
    if (this.reported.has(key)) return;
    this.reported.add(key);
    this.logger.warn(
      `Program ${programId}: the scene background asset read was not served by its team (${reason}); read unscoped`,
    );
  }
}
