import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import { PrismaService } from '../prisma.service';
import { ManagedMetricsService } from '../observability/managed-metrics.service';
import { DESTINATION_ID_PATTERN } from './broadcast-destinations.types';
import { parseIngestPayload } from './ingest-payload';

/** What the desktop studio needs to publish: the ingest address and the key, kept apart. */
export interface IngestCredential {
  destinationId: string;
  displayName: string;
  /** `scheme://host[:port]/application`, no key. */
  ingestUrl: string;
  streamKey: string;
}

export interface IngestSecretClient {
  send(command: GetSecretValueCommand): Promise<{
    SecretString?: string;
    VersionId?: string;
  }>;
}

/** The outcomes recorded in the audit row: a bounded set, never free text. */
type IngestOutcome = 'issued' | 'not_found' | 'retired' | 'unavailable';

/**
 * Returns one destination's ingest address and key, read from the Secrets Manager version the
 * catalog pins. Every call writes an audit row (who, which destination, when, outcome) and the
 * row is written before anything is returned: if it cannot be written, nothing is returned. The
 * key appears only in the return value; this class never logs, never puts it in an error and
 * drops the provider's own error text.
 */
@Injectable()
export class BroadcastIngestService {
  /** Created on first use; a test replaces it. */
  secretClient: IngestSecretClient | undefined;

  constructor(
    private readonly prisma: PrismaService,
    private readonly metrics: ManagedMetricsService,
  ) {}

  /**
   * `callerTeam` is the team the guard resolved for the caller (`0` only where no team is
   * configured, which production refuses). A destination of another team, or one with no team,
   * answers exactly like an unknown one: 404, audited as `not_found` with the destination's real
   * team, so the audit shows the attempt and the caller learns nothing about the other team.
   */
  async issue(
    destinationId: string,
    subject: string,
    callerTeam: number,
  ): Promise<IngestCredential> {
    if (!DESTINATION_ID_PATTERN.test(destinationId)) {
      throw new BadRequestException('Destination ID is invalid');
    }
    const destination = await this.prisma.broadcastDestination.findUnique({
      where: { id: destinationId },
    });
    if (
      !destination ||
      (callerTeam !== 0 && destination.teamId !== callerTeam)
    ) {
      await this.audit(
        destinationId,
        subject,
        'not_found',
        destination?.teamId ?? null,
      );
      throw new NotFoundException('Destination not found');
    }
    if (destination.retiredAt !== null) {
      await this.audit(destinationId, subject, 'retired', destination.teamId);
      throw new ConflictException('Destination is retired');
    }
    let credential: IngestCredential;
    try {
      credential = await this.read(
        destination.id,
        destination.displayName,
        destination.secretId,
        destination.secretVersionId,
      );
    } catch {
      await this.audit(
        destinationId,
        subject,
        'unavailable',
        destination.teamId,
      );
      throw new ServiceUnavailableException(
        'The destination credential is unavailable',
      );
    }
    await this.audit(destinationId, subject, 'issued', destination.teamId);
    return credential;
  }

  private async audit(
    destinationId: string,
    subject: string,
    outcome: IngestOutcome,
    teamId: number | null,
  ): Promise<void> {
    try {
      await this.prisma.broadcastIngestAccess.create({
        data: { teamId, destinationId, subject, outcome },
      });
    } catch {
      this.metrics.recordBroadcastDestination('ingest', 'failed');
      throw new ServiceUnavailableException(
        'The credential request could not be recorded',
      );
    }
    this.metrics.recordBroadcastDestination(
      'ingest',
      outcome === 'issued' ? 'succeeded' : 'failed',
    );
  }

  private async read(
    id: string,
    displayName: string,
    secretId: string,
    versionId: string,
  ): Promise<IngestCredential> {
    const client = (this.secretClient ??= new SecretsManagerClient({
      region: process.env.AWS_REGION,
    }));
    const response = await client.send(
      new GetSecretValueCommand({ SecretId: secretId, VersionId: versionId }),
    );
    if (
      response.VersionId !== versionId ||
      typeof response.SecretString !== 'string'
    ) {
      throw new Error('secret version mismatch');
    }
    const { payload, ingestUrl } = parseIngestPayload(
      JSON.parse(response.SecretString),
    );
    return {
      destinationId: id,
      displayName,
      ingestUrl,
      streamKey: payload.streamKey,
    };
  }
}
