import {
  BadGatewayException,
  ConflictException,
  Injectable,
} from '@nestjs/common';
import type { FillerVersion } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { ManagedMetricsService } from '../observability/managed-metrics.service';
import type { SafeAlanaState } from '../broadcast-destinations/broadcast-destinations.types';
import type { FillerConfig } from './filler.service';

/**
 * Binds a television Start to the program's prepared filler version
 * (gaulatti/alcantara#126). A program without one, or an Alana that predates
 * the profile-checksum acknowledgement, starts exactly as before.
 */
@Injectable()
export class FillerBindingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly metrics: ManagedMetricsService,
  ) {}

  /**
   * The television version a Start must bind to, checked against Alana's
   * lifecycle before Start is sent. Returns null, and changes nothing, when
   * the program has no ready television filler or Alana predates the
   * profile-checksum acknowledgement.
   */
  async televisionStartBinding(
    programId: string,
    status: SafeAlanaState,
  ): Promise<FillerVersion | null> {
    const version = await this.bindableTelevisionVersion(programId);
    const executor = status.pendingFiller ?? status.activeFiller;
    if (!version) {
      this.metrics.recordFillerStartBinding('not-configured');
      return null;
    }
    if (!executor?.profileChecksum) {
      this.metrics.recordFillerStartBinding('legacy-executor');
      return null;
    }
    const config = version.config as FillerConfig;
    if (
      executor.version !== version.id ||
      executor.ready !== true ||
      executor.profileChecksum !== config.profileChecksum
    ) {
      this.metrics.recordFillerStartBinding('mismatch');
      throw new ConflictException(
        'Alana is not prepared with the program television filler',
      );
    }
    return version;
  }

  /** Records that a Start ran with `version` as the session's filler. */
  async confirmTelevisionStart(
    programId: string,
    version: FillerVersion,
    status: SafeAlanaState,
  ): Promise<void> {
    if (status.activeFiller?.version !== version.id) {
      this.metrics.recordFillerStartBinding('mismatch');
      throw new BadGatewayException(
        'Alana did not start with the program television filler',
      );
    }
    // Each statement is atomic: the bound version becomes active, and stops
    // being pending only if it still is.
    const where = { programId, leg: 'television' };
    const promoted = await this.prisma.fillerLeg.updateMany({
      where: { ...where, pendingVersionId: version.id },
      data: { activeVersionId: version.id, pendingVersionId: null },
    });
    if (promoted.count === 0) {
      await this.prisma.fillerLeg.updateMany({
        where,
        data: { activeVersionId: version.id },
      });
    }
    this.metrics.recordFillerStartBinding('bound');
  }

  private async bindableTelevisionVersion(
    programId: string,
  ): Promise<FillerVersion | null> {
    const leg = await this.prisma.fillerLeg.findUnique({
      where: { programId_leg: { programId, leg: 'television' } },
    });
    const id = leg?.pendingVersionId ?? leg?.activeVersionId;
    if (!id) return null;
    return this.prisma.fillerVersion.findUnique({ where: { id } });
  }
}
