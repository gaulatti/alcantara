import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, type FillerVersion } from '@prisma/client';
import { createHash, randomUUID } from 'node:crypto';
import { PompeiiService } from '../auth/pompeii.service';
import { PrismaService } from '../prisma.service';
import { forTeam } from '../tenancy/scoped-prisma';
import { ManagedMetricsService } from '../observability/managed-metrics.service';
import {
  AlanaClient,
  AlanaRequestError,
} from '../broadcast-destinations/alana.client';
import {
  canonicalJson,
  type SafeAlanaFiller,
} from '../broadcast-destinations/broadcast-destinations.types';
import { PalazzoMachineClient } from '../radio/palazzo-machine.client';
import { readManagedMediaDigest } from './managed-media-digest';

export type FillerLegName = 'television' | 'radio';
export type FillerStatus = 'preparing' | 'ready' | 'failed';

/** The safe, immutable configuration a filler version stores. */
export type FillerConfig = {
  sources: { assetId: string; sha256: string }[];
  mode: 'loop' | 'ordered' | 'shuffle';
  shuffleSeed?: string;
  profileChecksum?: string;
};

const ASSET_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHUFFLE_SEED = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const MAX_RADIO_SOURCES = 100;
const TELEVISION_TYPES = new Set(['IMAGE', 'VIDEO']);

/**
 * Per-program television and radio filler configuration (gaulatti/alcantara#126):
 * immutable versions with checksums, a prepared next-session (pending) and an
 * in-session (active) version per leg, and the executor acknowledgement
 * required before a version counts as prepared. A program with no filler
 * configured has none, and every other path behaves as before.
 */
@Injectable()
export class FillerService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly alana: AlanaClient,
    private readonly palazzo: PalazzoMachineClient,
    private readonly config: ConfigService,
    private readonly metrics: ManagedMetricsService,
    private readonly pompeii: PompeiiService,
  ) {}

  /**
   * The media assets a program's filler may use (gaulatti/alcantara#122): its team's, all of them when no station team
   * is configured. A program with no team can use none; the refusal is counted.
   */
  private async assetDb(
    programId: string,
    leg: FillerLegName,
  ): Promise<PrismaService> {
    if (this.pompeii.teamId === 0) return this.prisma;
    const program = await this.prisma.program.findUnique({
      where: { programId },
      select: { teamId: true },
    });
    if (program?.teamId && program.teamId > 0) {
      return forTeam(this.prisma, program.teamId) as unknown as PrismaService;
    }
    this.metrics.recordFillerPreparation(leg, 'no-team');
    throw new BadRequestException(
      'this program has no team, so it can use no media asset',
    );
  }

  async getState(programId: string) {
    const program = await this.requireProgram(programId);
    const legs = programLegs(program.type);
    const rows = await this.prisma.fillerLeg.findMany({
      where: { programId },
    });
    const versionIds = rows.flatMap((row) =>
      [row.pendingVersionId, row.activeVersionId].filter(
        (id): id is string => id !== null,
      ),
    );
    const versions = new Map(
      (
        await this.prisma.fillerVersion.findMany({
          where: { id: { in: versionIds } },
        })
      ).map((version) => [version.id, version]),
    );
    return {
      programId,
      legs: Object.fromEntries(
        legs.map((leg) => {
          const row = rows.find((candidate) => candidate.leg === leg);
          return [
            leg,
            {
              pending: publicVersion(versions.get(row?.pendingVersionId ?? '')),
              active: publicVersion(versions.get(row?.activeVersionId ?? '')),
            },
          ];
        }),
      ),
    };
  }

  async prepareTelevision(
    programId: string,
    input: { assetId?: unknown },
    actorSubject: string,
  ) {
    const program = await this.requireProgram(programId);
    this.requireLeg(program.type, 'television');
    const assetId = requireAssetId(input.assetId);
    const assetDb = await this.assetDb(programId, 'television');
    const asset = await assetDb.mediaAsset.findUnique({
      where: { id: assetId },
      select: { id: true, enabled: true, mediaType: true, sourceUrl: true },
    });
    if (
      !asset?.enabled ||
      !asset.mediaType ||
      !TELEVISION_TYPES.has(asset.mediaType)
    ) {
      throw new BadRequestException(
        'television filler must be an enabled image or video media asset',
      );
    }
    let live: Awaited<ReturnType<AlanaClient['liveProfile']>>;
    try {
      live = await this.alana.liveProfile(programId);
    } catch {
      this.metrics.recordFillerPreparation('television', 'unavailable');
      throw new BadGatewayException('Alana live profile could not be read');
    }
    if (!live) {
      this.metrics.recordFillerPreparation('television', 'profile-unavailable');
      throw new ServiceUnavailableException(
        'television live profile unavailable',
      );
    }
    const sha256 = await readManagedMediaDigest(
      asset.sourceUrl,
      this.config,
      'television filler',
    );
    const version = await this.createVersion(
      programId,
      'television',
      {
        sources: [{ assetId, sha256 }],
        mode: 'loop',
        profileChecksum: live.checksum,
      },
      actorSubject,
    );
    let ack: SafeAlanaFiller | null;
    try {
      ack = await this.alana.prepareFiller(programId, version.id, {
        source: {
          id: executorSourceId(assetId),
          sha256,
          downloadUrl: asset.sourceUrl,
        },
        profile: live.profile,
      });
    } catch (error) {
      await this.finishVersion(version, 'failed', 'executor-rejected');
      this.metrics.recordFillerPreparation('television', 'failed');
      throw new BadGatewayException(
        error instanceof AlanaRequestError && error.status === 409
          ? 'Alana refused a conflicting filler version'
          : 'Alana could not prepare the television filler',
      );
    }
    if (
      !televisionAckMatches(
        ack,
        version.id,
        executorSourceId(assetId),
        sha256,
        live.checksum,
      )
    ) {
      await this.finishVersion(version, 'failed', 'acknowledgement-mismatch');
      this.metrics.recordFillerPreparation('television', 'failed');
      throw new BadGatewayException(
        'Alana did not acknowledge the exact television filler',
      );
    }
    await this.finishVersion(version, 'ready');
    this.metrics.recordFillerPreparation('television', 'ready');
    return this.getState(programId);
  }

  async prepareRadio(
    programId: string,
    input: { assetIds?: unknown; mode?: unknown; shuffleSeed?: unknown },
    actorSubject: string,
  ) {
    const program = await this.requireProgram(programId);
    this.requireLeg(program.type, 'radio');
    const assetIds = input.assetIds;
    if (
      !Array.isArray(assetIds) ||
      assetIds.length < 1 ||
      assetIds.length > MAX_RADIO_SOURCES ||
      new Set(assetIds).size !== assetIds.length ||
      assetIds.some((id) => typeof id !== 'string' || !ASSET_ID.test(id))
    ) {
      throw new BadRequestException(
        'select 1 to 100 distinct audio media assets',
      );
    }
    const order = parseOrder(input.mode, input.shuffleSeed);
    const settings = await this.prisma.radioSettings.findFirst({
      where: { programState: { programId } },
      select: { palazzoUrl: true },
    });
    if (!settings) {
      throw new BadGatewayException('Radio settings are unavailable');
    }
    const assetDb = await this.assetDb(programId, 'radio');
    const assets = await assetDb.mediaAsset.findMany({
      where: { id: { in: assetIds as string[] } },
      select: { id: true, enabled: true, mediaType: true, sourceUrl: true },
    });
    const byId = new Map(assets.map((asset) => [asset.id, asset]));
    const ordered = (assetIds as string[]).map((id) => byId.get(id));
    if (
      ordered.some((asset) => !asset?.enabled || asset.mediaType !== 'AUDIO')
    ) {
      throw new BadRequestException(
        'every radio filler source must be an enabled audio media asset',
      );
    }
    const sources: { assetId: string; sha256: string; downloadUrl: string }[] =
      [];
    for (const asset of ordered as NonNullable<(typeof ordered)[number]>[]) {
      sources.push({
        assetId: asset.id,
        sha256: await readManagedMediaDigest(
          asset.sourceUrl,
          this.config,
          'radio filler',
        ),
        downloadUrl: asset.sourceUrl,
      });
    }
    const version = await this.createVersion(
      programId,
      'radio',
      {
        sources: sources.map(({ assetId, sha256 }) => ({ assetId, sha256 })),
        ...order,
      },
      actorSubject,
    );
    try {
      await this.palazzo.prepareFiller(
        settings.palazzoUrl,
        programId,
        version.id,
        sources.map(({ assetId, sha256, downloadUrl }) => ({
          id: executorSourceId(assetId),
          sha256,
          downloadUrl,
        })),
        order,
      );
    } catch {
      await this.finishVersion(version, 'failed', 'executor-rejected');
      this.metrics.recordFillerPreparation('radio', 'failed');
      throw new BadGatewayException(
        'Palazzo could not prepare the radio filler',
      );
    }
    await this.finishVersion(version, 'ready');
    this.metrics.recordFillerPreparation('radio', 'ready');
    return this.getState(programId);
  }

  private async createVersion(
    programId: string,
    leg: FillerLegName,
    config: FillerConfig,
    actorSubject: string,
  ): Promise<FillerVersion> {
    return this.prisma.fillerVersion.create({
      data: {
        id: `filler-${leg === 'television' ? 'tv' : 'radio'}-${randomUUID()}`,
        programId,
        leg,
        checksum: fillerChecksum(programId, leg, config),
        config: config as unknown as Prisma.InputJsonValue,
        status: 'preparing',
        createdBy: actorSubject,
      },
    });
  }

  /**
   * Settles a version. Only a ready version becomes the leg's pending
   * next-session version; a failure leaves the known-good versions alone.
   */
  private async finishVersion(
    version: FillerVersion,
    status: Exclude<FillerStatus, 'preparing'>,
    reason?: string,
  ): Promise<void> {
    await this.prisma.fillerVersion.update({
      where: { id: version.id },
      data: {
        status,
        reason: reason ?? null,
        ...(status === 'ready' ? { preparedAt: new Date() } : {}),
      },
    });
    if (status !== 'ready') return;
    const where = { programId: version.programId, leg: version.leg };
    // INSERT … ON CONFLICT DO NOTHING: concurrent first preparations of the
    // same program leg cannot race on creating its row (Prisma's upsert is a
    // read then an insert, and two inserts collide on the primary key).
    await this.prisma.fillerLeg.createMany({
      data: [where],
      skipDuplicates: true,
    });
    // One conditional statement, so concurrent preparations cannot race: the
    // pointer moves only from nothing or from a version created no later
    // than this one. A slower, older preparation never replaces a newer one.
    const notNewer = await this.prisma.fillerVersion.findMany({
      where: { ...where, createdAt: { lte: version.createdAt } },
      select: { id: true },
    });
    await this.prisma.fillerLeg.updateMany({
      where: {
        ...where,
        OR: [
          { pendingVersionId: null },
          { pendingVersionId: { in: notNewer.map(({ id }) => id) } },
        ],
      },
      data: { pendingVersionId: version.id },
    });
  }

  private async requireProgram(programId: string) {
    const program = await this.prisma.programState.findUnique({
      where: { programId },
      select: { programId: true, type: true },
    });
    if (!program) throw new NotFoundException('Program not found');
    return program;
  }

  private requireLeg(type: string, leg: FillerLegName): void {
    if (!programLegs(type).includes(leg)) {
      throw new BadRequestException(`This program has no ${leg} leg`);
    }
  }
}

/** The legs a program type has: tv, radio or both. */
export function programLegs(type: string): FillerLegName[] {
  if (type === 'both') return ['television', 'radio'];
  return type === 'radio' ? ['radio'] : ['television'];
}

/**
 * The source id an executor sees for a media asset. Alana, Croccante and
 * Palazzo accept only `[A-Za-z0-9][A-Za-z0-9._-]{0,199}`, and managed asset
 * ids carry a `kind:` prefix, so the id is derived from the asset id.
 */
export function executorSourceId(assetId: string): string {
  return `asset-${createHash('sha256').update(assetId).digest('hex').slice(0, 40)}`;
}

/** SHA-256 of the canonical version identity and configuration. */
export function fillerChecksum(
  programId: string,
  leg: FillerLegName,
  config: FillerConfig,
): string {
  return createHash('sha256')
    .update(canonicalJson({ programId, leg, config }))
    .digest('hex');
}

function requireAssetId(value: unknown): string {
  if (typeof value !== 'string' || !ASSET_ID.test(value)) {
    throw new BadRequestException('assetId must be a media asset id');
  }
  return value;
}

function parseOrder(
  mode: unknown,
  shuffleSeed: unknown,
): { mode: 'ordered' } | { mode: 'shuffle'; shuffleSeed: string } {
  if (mode === undefined || mode === 'ordered') {
    if (shuffleSeed !== undefined) {
      throw new BadRequestException('shuffleSeed applies only to shuffle');
    }
    return { mode: 'ordered' };
  }
  if (mode !== 'shuffle') {
    throw new BadRequestException('mode must be ordered or shuffle');
  }
  if (typeof shuffleSeed !== 'string' || !SHUFFLE_SEED.test(shuffleSeed)) {
    throw new BadRequestException('shuffle requires a bounded shuffleSeed');
  }
  return { mode: 'shuffle', shuffleSeed };
}

function televisionAckMatches(
  ack: SafeAlanaFiller | null,
  version: string,
  assetId: string,
  sha256: string,
  profileChecksum: string,
): boolean {
  return (
    ack?.version === version &&
    ack.ready === true &&
    ack.status === 'ready' &&
    ack.sourceId === assetId &&
    ack.sourceSha256 === sha256 &&
    ack.profileChecksum === profileChecksum
  );
}

function publicVersion(version: FillerVersion | undefined) {
  if (!version) return null;
  return {
    version: version.id,
    checksum: version.checksum,
    status: version.status,
    reason: version.reason,
    config: version.config as FillerConfig,
    createdAt: version.createdAt,
    preparedAt: version.preparedAt,
  };
}
