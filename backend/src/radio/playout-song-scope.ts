import { Injectable, Logger } from '@nestjs/common';
import { PompeiiService } from '../auth/pompeii.service';
import { PrismaService } from '../prisma.service';
import { forTeam } from '../tenancy/scoped-prisma';
import {
  RadioMetricsService,
  type RadioSongScopePath,
  type RadioSongScopeReason,
} from './radio-metrics.service';
import { readProgramTeam } from '../tenancy/program-team';

/**
 * The song reads playout makes while a program is on air (gaulatti/alcantara#122): analysis for a command, recognising
 * an unannounced track, now-playing artwork and the playing track's cover.
 *
 * They read the program team's songs. Unlike every other lane, scoping never takes anything off air: whatever the scope
 * would refuse is read as it was before (unscoped) and counted, so the counter, not the listener, shows a program or
 * song in the wrong team. Station team `0` stays unscoped.
 */
@Injectable()
export class PlayoutSongScope {
  private readonly logger = new Logger(PlayoutSongScope.name);
  private readonly reported = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly pompeii: PompeiiService,
    private readonly metrics: RadioMetricsService,
  ) {}

  /** `query` run with the program's songs; `found` says whether a result holds a song. */
  async read<T>(
    path: RadioSongScopePath,
    programId: string,
    query: (db: PrismaService) => Promise<T>,
    found: (result: T) => boolean,
  ): Promise<T> {
    if (this.pompeii.teamId === 0) return query(this.prisma);
    try {
      const teamId = await readProgramTeam(this.prisma, programId);
      if (!teamId || teamId <= 0) {
        this.refuse(path, programId, 'no-team');
        return query(this.prisma);
      }
      const scoped = await query(
        forTeam(this.prisma, teamId) as unknown as PrismaService,
      );
      if (found(scoped)) return scoped;
    } catch {
      this.refuse(path, programId, 'lookup-failed');
      return query(this.prisma);
    }
    const unscoped = await query(this.prisma);
    if (found(unscoped)) this.refuse(path, programId, 'other-team');
    return unscoped;
  }

  private refuse(
    path: RadioSongScopePath,
    programId: string,
    reason: RadioSongScopeReason,
  ): void {
    this.metrics.recordRadioSongScopeRefusal(path, reason);
    const key = `${path}|${reason}|${programId}`;
    if (this.reported.has(key)) return;
    this.reported.add(key);
    this.logger.warn(
      `Program ${programId}: the ${path} song read was not served by its team (${reason}); read unscoped`,
    );
  }
}
