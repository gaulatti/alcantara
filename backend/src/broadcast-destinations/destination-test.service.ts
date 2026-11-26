import {
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { OutboundRefusal, checkedAddress } from '../outbound/safe-fetch';
import { ManagedMetricsService } from '../observability/managed-metrics.service';
import { PrismaService } from '../prisma.service';
import { BroadcastIngestService } from './broadcast-ingest.service';
import { parseIngestPayload } from './ingest-payload';
import { probeRtmp, type RtmpProbeResult } from './rtmp-probe';

/** One test per destination in this window: it opens a connection to a third party's ingest. */
export const TEST_INTERVAL_MS = 15_000;
export const TEST_TIMEOUT_MS = 8_000;

/**
 * The Test button of a saved destination (gaulatti/alcantara#384): reads the pinned key the way the desktop studio
 * does (audited), makes an RTMP publish handshake with no media, and answers accepted, refused or unreachable.
 * Neither the answer nor the logs carry the key.
 */
@Injectable()
export class DestinationTestService {
  /** Replaced by a test. */
  probe = probeRtmp;
  resolve = checkedAddress;
  private readonly lastRun = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly ingest: BroadcastIngestService,
    private readonly metrics: ManagedMetricsService,
  ) {}

  async test(
    destinationId: string,
    subject: string,
    callerTeam: number,
    now = Date.now(),
  ): Promise<RtmpProbeResult> {
    // The destination must be the caller's and live before its rate window or key is touched.
    const destination = await this.prisma.broadcastDestination.findUnique({
      where: { id: destinationId },
      select: { teamId: true, retiredAt: true },
    });
    if (
      !destination ||
      (callerTeam !== 0 && destination.teamId !== callerTeam)
    ) {
      throw new NotFoundException('Destination not found');
    }
    if (destination.retiredAt !== null) {
      throw new ConflictException('Destination is retired');
    }
    const last = this.lastRun.get(destinationId);
    if (last !== undefined && now - last < TEST_INTERVAL_MS) {
      throw new HttpException(
        'This destination was tested a moment ago; try again shortly',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    this.lastRun.set(destinationId, now);

    const credential = await this.ingest.issue(
      destinationId,
      subject,
      callerTeam,
    );
    const url = new URL(credential.ingestUrl);
    const { payload } = parseIngestPayload({
      scheme: url.protocol.slice(0, -1),
      host: url.hostname.replace(/^\[|\]$/g, ''),
      ...(url.port ? { port: Number(url.port) } : {}),
      application: url.pathname.slice(1),
      streamKey: credential.streamKey,
    });
    let result: RtmpProbeResult;
    try {
      const { address } = await this.resolve(payload.host);
      result = await this.probe({ ...payload, address }, TEST_TIMEOUT_MS);
    } catch (error) {
      if (!(error instanceof OutboundRefusal)) throw error;
      result = {
        result: 'unreachable',
        message:
          error.reason === 'address'
            ? 'The ingest address is not a public address'
            : 'The ingest host could not be found',
      };
    }
    this.metrics.recordBroadcastDestination(
      'test',
      result.result === 'accepted' ? 'succeeded' : 'failed',
    );
    return result;
  }
}
