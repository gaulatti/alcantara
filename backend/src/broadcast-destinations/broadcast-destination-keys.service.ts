import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ManagedMetricsService } from '../observability/managed-metrics.service';
import { PrismaService } from '../prisma.service';
import { DESTINATION_ID_PATTERN } from './broadcast-destinations.types';
import { catalogRow, cleanName } from './catalog-row';
import { DestinationSecretsService } from './destination-secrets.service';
import {
  IngestPayloadError,
  YOUTUBE_INGEST_URL,
  payloadFromIngestUrl,
} from './ingest-payload';

type Body = Record<string, unknown>;

const SERVICES = new Set(['youtube', 'custom']);

/**
 * Adds a destination by service, name and key, and replaces a key, writing the secret itself
 * (gaulatti/alcantara#376). The key goes from the request to Secrets Manager and nowhere else: it
 * is never stored, logged, put in an error, a metric label or an audit row. The row pins the
 * version Secrets Manager returned, so a failed write after a new version exists leaves the
 * pinned version, and so the running destinations, untouched.
 */
@Injectable()
export class BroadcastDestinationKeysService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly secrets: DestinationSecretsService,
    private readonly metrics: ManagedMetricsService,
  ) {}

  async add(body: Body, callerTeam: number, subject: string) {
    const name = cleanName(body.name);
    const target = ingestTarget(body);
    const { payload, ingestUrl } = payloadFor(target.url, body.streamKey);
    await this.requireUniqueName(name, callerTeam);
    const id = await this.freeId(name);
    const position = await this.prisma.broadcastDestination.count();
    let secret: { secretId: string; versionId: string };
    try {
      secret = await this.secrets.create(
        DestinationSecretsService.nameFor(callerTeam, id),
        payload,
      );
    } catch {
      this.metrics.recordBroadcastDestination('create', 'failed');
      throw new ServiceUnavailableException('The key could not be saved');
    }
    const teamId = callerTeam === 0 ? null : callerTeam;
    try {
      const [created] = await this.prisma.$transaction([
        this.prisma.broadcastDestination.create({
          data: {
            id,
            displayName: name,
            secretId: secret.secretId,
            secretVersionId: secret.versionId,
            service: target.service,
            ingestUrl,
            keyLast4: last4(payload.streamKey),
            keySetAt: new Date(),
            position,
            teamId,
          },
        }),
        this.prisma.broadcastDestinationKeyChange.create({
          data: { teamId, destinationId: id, subject, action: 'created' },
        }),
      ]);
      this.metrics.recordBroadcastDestination('create', 'succeeded');
      return catalogRow(created);
    } catch (error) {
      await this.secrets.discard(secret.secretId).catch(() => undefined);
      this.metrics.recordBroadcastDestination('create', 'failed');
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException('Destination already exists');
      }
      throw new ServiceUnavailableException(
        'The destination could not be saved',
      );
    }
  }

  async replaceKey(
    destinationId: string,
    body: Body,
    callerTeam: number,
    subject: string,
  ) {
    if (!DESTINATION_ID_PATTERN.test(destinationId)) {
      throw new BadRequestException('Destination ID is invalid');
    }
    const existing = await this.prisma.broadcastDestination.findUnique({
      where: { id: destinationId },
    });
    if (!existing || (callerTeam !== 0 && existing.teamId !== callerTeam)) {
      throw new NotFoundException('Destination not found');
    }
    if (existing.retiredAt !== null) {
      throw new ConflictException('Destination is retired');
    }
    // A row added by hand has no service yet: replacing its key moves it under a secret this
    // backend owns, so the request names the service as it does when adding.
    const legacy = existing.service === null || existing.ingestUrl === null;
    if (
      !legacy &&
      (body.service !== undefined || body.ingestUrl !== undefined)
    ) {
      throw new BadRequestException(
        'The service of a destination cannot be changed',
      );
    }
    const target = legacy
      ? ingestTarget(body)
      : { service: existing.service, url: existing.ingestUrl as string };
    const { payload, ingestUrl } = payloadFor(target.url, body.streamKey);
    let secretId = existing.secretId;
    let versionId: string;
    let created = false;
    try {
      if (legacy) {
        const made = await this.secrets.create(
          DestinationSecretsService.nameFor(callerTeam, existing.id),
          payload,
        );
        secretId = made.secretId;
        versionId = made.versionId;
        created = true;
      } else {
        versionId = await this.secrets.put(secretId, payload);
      }
    } catch {
      this.metrics.recordBroadcastDestination('replace_key', 'failed');
      throw new ServiceUnavailableException('The key could not be saved');
    }
    try {
      const [updated] = await this.prisma.$transaction([
        this.prisma.broadcastDestination.update({
          where: { id: existing.id },
          data: {
            secretId,
            secretVersionId: versionId,
            service: target.service,
            ingestUrl,
            keyLast4: last4(payload.streamKey),
            keySetAt: new Date(),
          },
        }),
        this.prisma.broadcastDestinationKeyChange.create({
          data: {
            teamId: existing.teamId,
            destinationId: existing.id,
            subject,
            action: 'replaced',
          },
        }),
      ]);
      this.metrics.recordBroadcastDestination('replace_key', 'succeeded');
      return catalogRow(updated);
    } catch {
      if (created) await this.secrets.discard(secretId).catch(() => undefined);
      this.metrics.recordBroadcastDestination('replace_key', 'failed');
      throw new ServiceUnavailableException(
        'The destination could not be saved',
      );
    }
  }

  private async requireUniqueName(name: string, callerTeam: number) {
    const clash = await this.prisma.broadcastDestination.findFirst({
      where: {
        displayName: { equals: name, mode: 'insensitive' },
        ...(callerTeam === 0 ? {} : { teamId: callerTeam }),
      },
      select: { id: true },
    });
    if (clash) {
      throw new ConflictException(
        'A destination with this name already exists',
      );
    }
  }

  /** The id is the name as a slug, made unique with a numeric suffix. */
  private async freeId(name: string): Promise<string> {
    const base =
      name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 48)
        .replace(/-+$/g, '') || 'destination';
    const taken = new Set(
      (
        await this.prisma.broadcastDestination.findMany({
          where: { id: { startsWith: base } },
          select: { id: true },
        })
      ).map((row) => row.id),
    );
    let candidate = base;
    for (let suffix = 2; taken.has(candidate); suffix += 1) {
      candidate = `${base}-${suffix}`;
    }
    return candidate;
  }
}

function ingestTarget(body: Body): { service: string; url: string } {
  const service = body.service;
  if (typeof service !== 'string' || !SERVICES.has(service)) {
    throw new BadRequestException('Choose YouTube or a custom RTMP(S) service');
  }
  if (service === 'youtube') {
    if (body.ingestUrl !== undefined) {
      throw new BadRequestException('The YouTube ingest URL is fixed');
    }
    return { service, url: YOUTUBE_INGEST_URL };
  }
  if (typeof body.ingestUrl !== 'string' || !body.ingestUrl.trim()) {
    throw new BadRequestException('A custom destination needs an ingest URL');
  }
  return { service, url: body.ingestUrl };
}

function payloadFor(url: string, key: unknown) {
  if (typeof key !== 'string') {
    throw new BadRequestException('A stream key is required');
  }
  try {
    return payloadFromIngestUrl(url, key);
  } catch (error) {
    // payloadFromIngestUrl only throws IngestPayloadError, whose text is safe to show.
    throw new BadRequestException((error as IngestPayloadError).message);
  }
}

/** Shows at most the last four characters, and nothing for a short key. */
function last4(key: string): string | null {
  return key.length >= 8 ? key.slice(-4) : null;
}
