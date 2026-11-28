import {
  PlayoutLease,
  startWhenActive,
} from '../playout/playout-lease.service';
import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
  Optional,
} from '@nestjs/common';
import { isDeployCandidate } from '../config/deploy-candidate';
import { ManagedMetricsService } from '../observability/managed-metrics.service';
import { PrismaService } from '../prisma.service';

export const RADIO_SCOPE_PREFLIGHT_INTERVAL_MS = 5 * 60 * 1000;

/**
 * What must read zero before the radio's song reads are scoped to a team
 * (gaulatti/alcantara#122): radio programs with no team, and library songs with
 * no team. A scoped read finds neither. Read-only; the counts are published
 * only while the last read succeeded, so no value is ever assumed.
 */
@Injectable()
export class RadioScopePreflightService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(RadioScopePreflightService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly metrics: ManagedMetricsService,
    @Optional() private readonly lease?: PlayoutLease,
  ) {}

  /** The first read, which start-up does not wait for. */
  private first: Promise<void> = Promise.resolve();

  /** The port does not open until every start-up hook returns (alcantara#873), so the first read is not awaited. */
  onApplicationBootstrap(): void {
    if (isDeployCandidate()) return;
    // Only the instance holding the playout lease (alcantara#873) runs it. The first read is not returned, so
    // neither start-up nor an activation waits for it.
    void startWhenActive(this.lease, () => {
      this.timer = setInterval(
        () => void this.refresh(),
        RADIO_SCOPE_PREFLIGHT_INTERVAL_MS,
      );
      this.timer.unref();
      this.first = this.refresh();
    });
  }

  /** Resolves when the first read has finished (also if it failed). */
  whenStarted(): Promise<void> {
    return this.first;
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Reads both counts and publishes them. A failed read withdraws them. */
  async refresh(): Promise<void> {
    try {
      const radio = await this.prisma.programState.findMany({
        where: { type: { in: ['radio', 'both'] } },
        select: { programId: true },
      });
      const [owned, songs] = await Promise.all([
        this.prisma.program.count({
          where: {
            programId: { in: radio.map((state) => state.programId) },
            teamId: { gt: 0 },
          },
        }),
        this.prisma.song.count({
          where: { OR: [{ teamId: null }, { teamId: { lte: 0 } }] },
        }),
      ]);
      this.metrics.setRadioScopePreflight({
        radioProgramsWithoutTeam: radio.length - owned,
        librarySongsWithoutTeam: songs,
      });
    } catch {
      // Never the error itself: it can carry a query or a host.
      this.logger.warn('Radio scope preflight could not read the database');
      this.metrics.setRadioScopePreflight(null);
    }
  }
}
