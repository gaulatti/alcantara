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
import { isIP } from 'node:net';
import { PrismaService } from '../prisma.service';
import { ManagedMetricsService } from '../observability/managed-metrics.service';
import { DESTINATION_ID_PATTERN } from './broadcast-destinations.types';

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

const SECRET_FIELDS = new Set([
  'scheme',
  'host',
  'port',
  'application',
  'streamKey',
]);
const HOST_PATTERN =
  /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
const APPLICATION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;

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
    const payload: unknown = JSON.parse(response.SecretString);
    if (
      typeof payload !== 'object' ||
      payload === null ||
      Array.isArray(payload)
    ) {
      throw new Error('invalid payload');
    }
    const fields = payload as Record<string, unknown>;
    if (Object.keys(fields).some((key) => !SECRET_FIELDS.has(key))) {
      throw new Error('unexpected field');
    }
    const { scheme, host, port, application, streamKey } = fields;
    if (scheme !== 'rtmp' && scheme !== 'rtmps') {
      throw new Error('scheme');
    }
    if (
      typeof host !== 'string' ||
      !(HOST_PATTERN.test(host) || isIP(host) !== 0)
    ) {
      throw new Error('host');
    }
    if (
      typeof application !== 'string' ||
      !APPLICATION_PATTERN.test(application) ||
      application.split('/').includes('..')
    ) {
      throw new Error('application');
    }
    if (
      typeof streamKey !== 'string' ||
      streamKey.length < 1 ||
      streamKey.length > 512 ||
      /\s/.test(streamKey) ||
      [...streamKey].some((char) => char.charCodeAt(0) < 32)
    ) {
      throw new Error('key');
    }
    let authority = isIP(host) === 6 ? `[${host}]` : host;
    if (port !== undefined) {
      if (
        typeof port !== 'number' ||
        !Number.isInteger(port) ||
        port < 1 ||
        port > 65535
      ) {
        throw new Error('port');
      }
      authority = `${authority}:${port}`;
    }
    return {
      destinationId: id,
      displayName,
      ingestUrl: `${scheme}://${authority}/${application}`,
      streamKey,
    };
  }
}
