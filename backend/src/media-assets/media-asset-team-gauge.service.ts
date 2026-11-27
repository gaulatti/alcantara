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

export const MEDIA_ASSET_TEAM_GAUGE_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Media assets with no team (gaulatti/alcantara#122): a team-scoped read finds
 * none of them. Read-only; the count is published only while the last read
 * succeeded, so no value is ever assumed.
 */
@Injectable()
export class MediaAssetTeamGaugeService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(MediaAssetTeamGaugeService.name);
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
    // Only the instance holding the playout lease (alcantara#873) publishes the gauge. The first read is not returned, so
    // neither start-up nor an activation waits for it.
    void startWhenActive(this.lease, () => {
      this.timer = setInterval(
        () => void this.refresh(),
        MEDIA_ASSET_TEAM_GAUGE_INTERVAL_MS,
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

  /** Reads the count and publishes it. A failed read withdraws it. */
  async refresh(): Promise<void> {
    try {
      this.metrics.setMediaAssetsWithoutTeam(
        await this.prisma.mediaAsset.count({
          where: { OR: [{ teamId: null }, { teamId: { lte: 0 } }] },
        }),
      );
    } catch {
      // Never the error itself: it can carry a query or a host.
      this.logger.warn('Media asset team count could not be read');
      this.metrics.setMediaAssetsWithoutTeam(null);
    }
  }
}
