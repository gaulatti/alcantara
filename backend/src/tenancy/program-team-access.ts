import { Injectable } from '@nestjs/common';
import { PompeiiService } from '../auth/pompeii.service';
import { ManagedMetricsService } from '../observability/managed-metrics.service';
import { PrismaService } from '../prisma.service';

/**
 * Whether a caller's team may act on a program (gaulatti/alcantara#122): it may unless the program belongs to another
 * team. A program with no Program row or no team belongs to nobody; it stays usable and is counted. Station team `0`
 * (local and test) is not checked.
 */
@Injectable()
export class ProgramTeamAccess {
  constructor(
    private readonly prisma: PrismaService,
    private readonly pompeii: PompeiiService,
    private readonly metrics: ManagedMetricsService,
  ) {}

  async allows(programId: string, teamId: number): Promise<boolean> {
    if (teamId <= 0) return true;
    const program = await this.prisma.program.findUnique({
      where: { programId: programId.trim() },
      select: { teamId: true },
    });
    if (!program?.teamId || program.teamId <= 0) {
      this.metrics.recordProgramTeamCheck('unowned');
      return true;
    }
    if (program.teamId === teamId) return true;
    this.metrics.recordProgramTeamCheck('refused');
    return false;
  }

  /** The same for a caller that acts as the station team: MCP. */
  allowsStation(programId: string): Promise<boolean> {
    return this.allows(programId, this.pompeii.teamId);
  }
}
