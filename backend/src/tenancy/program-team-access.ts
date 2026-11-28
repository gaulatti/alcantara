import { Injectable, Logger } from '@nestjs/common';
import { PompeiiService } from '../auth/pompeii.service';
import { ManagedMetricsService } from '../observability/managed-metrics.service';
import { PrismaService } from '../prisma.service';

/** How long a program's team is remembered, so desk polls and on-air control do not read the database each time. */
export const PROGRAM_TEAM_TTL_MS = 30_000;
/** A lookup that has not answered by now has failed: it must not hold up an on-air command. */
export const PROGRAM_TEAM_LOOKUP_TIMEOUT_MS = 1_000;
/** Ids come from requests, so the cache is bounded. */
export const PROGRAM_TEAM_CACHE_LIMIT = 1_000;

/**
 * Whether a caller's team may act on a program (gaulatti/alcantara#122): it may unless the program belongs to another
 * team. A program with no Program row or no team belongs to nobody; it stays usable and is counted. Station team `0`
 * (local and test) is not checked.
 *
 * A lookup that fails never blocks a request: Stop failing during a database blip would be worse than the gap. It is
 * counted, and the last team read for the program, if any, still applies.
 */
@Injectable()
export class ProgramTeamAccess {
  private readonly logger = new Logger(ProgramTeamAccess.name);
  private readonly cache = new Map<
    string,
    { teamId: number | null; at: number }
  >();

  constructor(
    private readonly prisma: PrismaService,
    private readonly pompeii: PompeiiService,
    private readonly metrics: ManagedMetricsService,
  ) {}

  async allows(programId: string, teamId: number): Promise<boolean> {
    if (teamId <= 0) return true;
    const owner = await this.ownerOf(programId.trim());
    if (owner === undefined) return true;
    if (owner === null || owner <= 0) {
      this.metrics.recordProgramTeamCheck('unowned');
      return true;
    }
    if (owner === teamId) return true;
    this.metrics.recordProgramTeamCheck('refused');
    return false;
  }

  /** The same for a caller that acts as the station team: MCP. */
  allowsStation(programId: string): Promise<boolean> {
    return this.allows(programId, this.pompeii.teamId);
  }

  /**
   * The team a program belongs to, for a row that records it (gaulatti/alcantara#122): null when the program has no
   * team or none could be read. Read through the same cache as the check.
   */
  async teamOf(programId: string): Promise<number | null> {
    const owner = await this.ownerOf(programId.trim());
    return owner !== undefined && owner !== null && owner > 0 ? owner : null;
  }

  /** Forgets a program's team, after it is created, renamed or deleted, or its team changes. */
  invalidate(programId: string): void {
    this.cache.delete(programId.trim());
  }

  /** The program's team, null when it has none, or undefined when it could not be read and none is remembered. */
  private async ownerOf(programId: string): Promise<number | null | undefined> {
    const known = this.cache.get(programId);
    if (known && Date.now() - known.at < PROGRAM_TEAM_TTL_MS) {
      return known.teamId;
    }
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error('program team lookup timed out')),
        PROGRAM_TEAM_LOOKUP_TIMEOUT_MS,
      );
    });
    try {
      const program = await Promise.race([
        this.prisma.program.findUnique({
          where: { programId },
          select: { teamId: true },
        }),
        timeout,
      ]).finally(() => clearTimeout(timer));
      const teamId = program?.teamId ?? null;
      if (this.cache.size >= PROGRAM_TEAM_CACHE_LIMIT) this.cache.clear();
      this.cache.set(programId, { teamId, at: Date.now() });
      return teamId;
    } catch (error) {
      this.metrics.recordProgramTeamCheck('lookup-failed');
      this.logger.warn(
        `Program team lookup failed (${error instanceof Error ? error.name : typeof error}); the request is not blocked`,
      );
      return known?.teamId;
    }
  }
}
