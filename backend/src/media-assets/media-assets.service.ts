import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { MediaAssetKind, MediaAssetType, Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma.service';
import {
  assertCanManageLabels,
  assertCanManageBackgroundAudio,
  assertCanManageMediaAsset,
  readableMediaAssetWhere,
} from './media-asset-authorization';

const MEDIA_ASSET_INCLUDE = {
  image: true,
  audioClip: true,
  backgroundAudio: true,
  song: true,
  songCovers: { select: { id: true } },
  transition: true,
  labels: {
    include: { label: true },
    orderBy: [
      { label: { name: 'asc' as const } },
      { position: 'asc' as const },
    ],
  },
} satisfies Prisma.MediaAssetInclude;

const MEDIA_LABEL_INCLUDE = {
  assets: {
    include: {
      asset: { include: MEDIA_ASSET_INCLUDE },
    },
    orderBy: { position: 'asc' as const },
  },
} satisfies Prisma.MediaLabelInclude;

type MediaAssetRecord = Prisma.MediaAssetGetPayload<{
  include: typeof MEDIA_ASSET_INCLUDE;
}>;

type MediaLabelRecord = Prisma.MediaLabelGetPayload<{
  include: typeof MEDIA_LABEL_INCLUDE;
}>;

export interface MediaAssetAuthorization {
  permissions: string[];
}

interface FindAssetsInput {
  search?: string;
  mediaType?: string;
  capability?: string;
  labelId?: string;
  page: number;
  limit: number;
}

interface FindLabelsInput {
  search?: string;
  page: number;
  limit: number;
}

const LEGACY_LABEL_PREFIX = 'legacy-media-group:';

function resolveMediaType(asset: {
  mediaType: MediaAssetType | null;
  kind: MediaAssetKind | null;
}): MediaAssetType {
  if (asset.mediaType) return asset.mediaType;
  switch (asset.kind) {
    case MediaAssetKind.IMAGE:
      return MediaAssetType.IMAGE;
    case MediaAssetKind.TRANSITION:
      return MediaAssetType.VIDEO;
    case MediaAssetKind.AUDIO_CLIP:
    case MediaAssetKind.SONG:
      return MediaAssetType.AUDIO;
    default:
      throw new Error(`Media asset ${String(asset.kind)} has no physical type`);
  }
}

@Injectable()
export class MediaAssetsService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(
    input: FindAssetsInput,
    authorization: MediaAssetAuthorization,
  ) {
    const filters: Prisma.MediaAssetWhereInput[] = [
      readableMediaAssetWhere(authorization.permissions),
    ];
    const search = input.search?.trim();
    if (search) {
      filters.push({ name: { contains: search, mode: 'insensitive' } });
    }
    if (input.mediaType) {
      if (
        !Object.values(MediaAssetType).includes(
          input.mediaType as MediaAssetType,
        )
      ) {
        throw new BadRequestException('Unknown mediaType');
      }
      filters.push({ mediaType: input.mediaType as MediaAssetType });
    }
    if (input.capability) {
      filters.push(this.capabilityWhere(input.capability));
    }
    if (input.labelId?.trim()) {
      filters.push({ labels: { some: { labelId: input.labelId.trim() } } });
    }

    const where: Prisma.MediaAssetWhereInput = { AND: filters };
    const skip = (input.page - 1) * input.limit;
    const [assets, total] = await Promise.all([
      this.prisma.mediaAsset.findMany({
        where,
        include: MEDIA_ASSET_INCLUDE,
        orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
        skip,
        take: input.limit,
      }),
      this.prisma.mediaAsset.count({ where }),
    ]);

    return {
      data: assets.map((asset) => this.mapAsset(asset)),
      meta: {
        total,
        page: input.page,
        limit: input.limit,
        totalPages: Math.ceil(total / input.limit),
      },
    };
  }

  async findOne(id: string, authorization: MediaAssetAuthorization) {
    const asset = await this.prisma.mediaAsset.findFirst({
      where: {
        AND: [
          { id: this.requiredId(id, 'asset id') },
          readableMediaAssetWhere(authorization.permissions),
        ],
      },
      include: MEDIA_ASSET_INCLUDE,
    });
    if (!asset) throw new NotFoundException('Media asset not found');
    return this.mapAsset(asset);
  }

  async createBackgroundAudio(
    input: { name?: unknown; sourceUrl?: unknown; defaultVolume?: unknown },
    authorization: MediaAssetAuthorization,
  ) {
    assertCanManageBackgroundAudio(authorization.permissions);
    const name = this.requiredString(input.name, 'name');
    const sourceUrl = this.requiredString(input.sourceUrl, 'sourceUrl');
    const defaultVolume = this.volume(input.defaultVolume);
    const asset = await this.prisma.mediaAsset.create({
      data: {
        id: `media:${randomUUID()}`,
        mediaType: MediaAssetType.AUDIO,
        name,
        sourceUrl,
        backgroundAudio: { create: { defaultVolume } },
      },
      include: MEDIA_ASSET_INCLUDE,
    });
    return this.mapAsset(asset);
  }

  async removeStandaloneAsset(
    id: string,
    authorization: MediaAssetAuthorization,
  ) {
    const assetId = this.requiredId(id, 'asset id');
    const asset = await this.prisma.mediaAsset.findUnique({
      where: { id: assetId },
      include: MEDIA_ASSET_INCLUDE,
    });
    if (!asset) throw new NotFoundException('Media asset not found');
    assertCanManageMediaAsset(asset, authorization.permissions);
    if (
      asset.image ||
      asset.audioClip ||
      asset.song ||
      asset.songCovers.length > 0 ||
      asset.transition
    ) {
      throw new BadRequestException(
        'Use the capability-specific editor to delete this media asset',
      );
    }
    await this.prisma.mediaAsset.delete({ where: { id: assetId } });
    return { deletedMediaAssetId: assetId };
  }

  async replaceAssetLabels(
    id: string,
    labelIdsValue: unknown,
    authorization: MediaAssetAuthorization,
  ) {
    const assetId = this.requiredId(id, 'asset id');
    const labelIds = this.normalizeIds(labelIdsValue, 'labelIds');
    const asset = await this.prisma.mediaAsset.findUnique({
      where: { id: assetId },
      include: MEDIA_ASSET_INCLUDE,
    });
    if (!asset) throw new NotFoundException('Media asset not found');
    assertCanManageMediaAsset(asset, authorization.permissions);

    const labels = await this.prisma.mediaLabel.findMany({
      where: { id: { in: labelIds } },
      select: { id: true },
    });
    this.assertIdsExist(
      labelIds,
      labels.map((label) => label.id),
      'labels',
    );
    if (
      labelIds.some((labelId) => this.legacyGroupId(labelId) !== null) &&
      (resolveMediaType(asset) !== MediaAssetType.IMAGE || !asset.image)
    ) {
      throw new BadRequestException(
        'Imported slideshow labels can contain only image assets',
      );
    }

    await this.prisma.$transaction(async (tx) => {
      const current = await tx.mediaAssetLabel.findMany({
        where: { assetId },
        select: { labelId: true, position: true },
      });
      const currentPositions = new Map(
        current.map((assignment) => [assignment.labelId, assignment.position]),
      );
      const affectedLabelIds = [
        ...new Set([...current.map((row) => row.labelId), ...labelIds]),
      ];
      await tx.mediaAssetLabel.deleteMany({ where: { assetId } });
      for (const labelId of labelIds) {
        const currentPosition = currentPositions.get(labelId);
        const maximum =
          currentPosition === undefined
            ? await tx.mediaAssetLabel.aggregate({
                where: { labelId },
                _max: { position: true },
              })
            : null;
        await tx.mediaAssetLabel.create({
          data: {
            assetId,
            labelId,
            position: currentPosition ?? (maximum?._max.position ?? -1) + 1,
          },
        });
      }
      await this.syncLegacyGroupsFromLabels(tx, affectedLabelIds);
    });

    return this.findOne(assetId, authorization);
  }

  async findLabels(
    input: FindLabelsInput,
    authorization: MediaAssetAuthorization,
  ) {
    const search = input.search?.trim();
    const where: Prisma.MediaLabelWhereInput = search
      ? { name: { contains: search, mode: 'insensitive' } }
      : {};
    const skip = (input.page - 1) * input.limit;
    const readableWhere = readableMediaAssetWhere(authorization.permissions);
    const [labels, total] = await Promise.all([
      this.prisma.mediaLabel.findMany({
        where,
        include: {
          assets: {
            where: { asset: readableWhere },
            include: { asset: { include: MEDIA_ASSET_INCLUDE } },
            orderBy: { position: 'asc' },
          },
        },
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
        skip,
        take: input.limit,
      }),
      this.prisma.mediaLabel.count({ where }),
    ]);

    return {
      data: labels.map((label) => this.mapLabel(label)),
      meta: {
        total,
        page: input.page,
        limit: input.limit,
        totalPages: Math.ceil(total / input.limit),
      },
    };
  }

  async findLabel(id: string, authorization: MediaAssetAuthorization) {
    const label = await this.prisma.mediaLabel.findUnique({
      where: { id: this.requiredId(id, 'label id') },
      include: {
        assets: {
          where: {
            asset: readableMediaAssetWhere(authorization.permissions),
          },
          include: { asset: { include: MEDIA_ASSET_INCLUDE } },
          orderBy: { position: 'asc' },
        },
      },
    });
    if (!label) throw new NotFoundException('Media label not found');
    return this.mapLabel(label);
  }

  async resolveLabelImages(id: string) {
    const label = await this.prisma.mediaLabel.findUnique({
      where: { id: this.requiredId(id, 'label id') },
      select: {
        id: true,
        name: true,
        assets: {
          where: {
            asset: {
              mediaType: MediaAssetType.IMAGE,
              enabled: true,
            },
          },
          orderBy: { position: 'asc' },
          select: {
            position: true,
            asset: { select: { id: true, name: true, sourceUrl: true } },
          },
        },
      },
    });
    if (!label) throw new NotFoundException('Media label not found');
    return {
      id: label.id,
      name: label.name,
      images: label.assets.map(({ asset, position }) => ({
        assetId: asset.id,
        name: asset.name,
        imageUrl: asset.sourceUrl,
        position,
      })),
    };
  }

  async createLabel(
    input: { name?: unknown; description?: unknown },
    authorization: MediaAssetAuthorization,
  ) {
    assertCanManageLabels(authorization.permissions);
    const name = this.requiredString(input.name, 'name');
    const description = this.optionalString(input.description, 'description');
    try {
      const label = await this.prisma.mediaLabel.create({
        data: { name, description },
        include: MEDIA_LABEL_INCLUDE,
      });
      return this.mapLabel(label);
    } catch (error) {
      this.rethrowUniqueName(error);
    }
  }

  async updateLabel(
    id: string,
    input: { name?: unknown; description?: unknown },
    authorization: MediaAssetAuthorization,
  ) {
    assertCanManageLabels(authorization.permissions);
    const labelId = this.requiredId(id, 'label id');
    const existing = await this.prisma.mediaLabel.findUnique({
      where: { id: labelId },
      select: { id: true },
    });
    if (!existing) throw new NotFoundException('Media label not found');

    const data: Prisma.MediaLabelUpdateInput = {};
    if (input.name !== undefined)
      data.name = this.requiredString(input.name, 'name');
    if (input.description !== undefined) {
      data.description = this.optionalString(input.description, 'description');
    }
    try {
      const label = await this.prisma.$transaction(async (tx) => {
        if (Object.keys(data).length > 0) {
          await tx.mediaLabel.update({ where: { id: labelId }, data });
        }
        const legacyGroupId = this.legacyGroupId(labelId);
        if (legacyGroupId !== null && Object.keys(data).length > 0) {
          const mediaGroupData: Prisma.MediaGroupUpdateInput = {};
          if (typeof data.name === 'string') mediaGroupData.name = data.name;
          if (
            data.description === null ||
            typeof data.description === 'string'
          ) {
            mediaGroupData.description = data.description;
          }
          await tx.mediaGroup.update({
            where: { id: legacyGroupId },
            data: mediaGroupData,
          });
        }
        return tx.mediaLabel.findUniqueOrThrow({
          where: { id: labelId },
          include: MEDIA_LABEL_INCLUDE,
        });
      });
      return this.mapLabel(label);
    } catch (error) {
      this.rethrowUniqueName(error);
    }
  }

  async replaceLabelAssets(
    id: string,
    assetIdsValue: unknown,
    authorization: MediaAssetAuthorization,
  ) {
    const labelId = this.requiredId(id, 'label id');
    const assetIds = this.normalizeIds(assetIdsValue, 'assetIds');
    const label = await this.prisma.mediaLabel.findUnique({
      where: { id: labelId },
      select: { id: true },
    });
    if (!label) throw new NotFoundException('Media label not found');

    const currentAssignments = await this.prisma.mediaAssetLabel.findMany({
      where: { labelId },
      select: { assetId: true },
    });
    const affectedAssetIds = [
      ...new Set([
        ...currentAssignments.map((row) => row.assetId),
        ...assetIds,
      ]),
    ];
    const assets = await this.prisma.mediaAsset.findMany({
      where: { id: { in: affectedAssetIds } },
      include: MEDIA_ASSET_INCLUDE,
    });
    this.assertIdsExist(
      assetIds,
      assets.map((asset) => asset.id),
      'assets',
    );
    assets.forEach((asset) =>
      assertCanManageMediaAsset(asset, authorization.permissions),
    );

    if (
      this.legacyGroupId(labelId) !== null &&
      assets.some(
        (asset) =>
          resolveMediaType(asset) !== MediaAssetType.IMAGE || !asset.image,
      )
    ) {
      throw new BadRequestException(
        'Imported slideshow labels can contain only image assets',
      );
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.mediaAssetLabel.deleteMany({ where: { labelId } });
      if (assetIds.length > 0) {
        await tx.mediaAssetLabel.createMany({
          data: assetIds.map((assetId, position) => ({
            labelId,
            assetId,
            position,
          })),
        });
      }
      await this.syncLegacyGroupsFromLabels(tx, [labelId]);
    });
    return this.findLabel(labelId, authorization);
  }

  async removeLabel(id: string, authorization: MediaAssetAuthorization) {
    assertCanManageLabels(authorization.permissions);
    const labelId = this.requiredId(id, 'label id');
    const existing = await this.prisma.mediaLabel.findUnique({
      where: { id: labelId },
      select: { id: true },
    });
    if (!existing) throw new NotFoundException('Media label not found');

    await this.prisma.$transaction(async (tx) => {
      const legacyGroupId = this.legacyGroupId(labelId);
      if (legacyGroupId !== null) {
        await tx.mediaGroup.delete({ where: { id: legacyGroupId } });
      } else {
        await tx.mediaLabel.delete({ where: { id: labelId } });
      }
    });
    return { deletedMediaLabelId: labelId };
  }

  private capabilityWhere(value: string): Prisma.MediaAssetWhereInput {
    switch (value.trim().toUpperCase()) {
      case 'INSTANT':
        return { audioClip: { isNot: null } };
      case 'BACKGROUND':
        return { backgroundAudio: { isNot: null } };
      case 'SONG':
        return { song: { isNot: null } };
      case 'COVER':
        return { songCovers: { some: {} } };
      case 'TRANSITION':
        return { transition: { isNot: null } };
      default:
        throw new BadRequestException('Unknown capability');
    }
  }

  private mapAsset(asset: MediaAssetRecord) {
    const capabilities: string[] = [];
    if (asset.audioClip) capabilities.push('INSTANT');
    if (asset.backgroundAudio) capabilities.push('BACKGROUND');
    if (asset.song) capabilities.push('SONG');
    if (asset.songCovers.length > 0) capabilities.push('COVER');
    if (asset.transition) capabilities.push('TRANSITION');
    return {
      id: asset.id,
      mediaType: resolveMediaType(asset),
      name: asset.name,
      sourceUrl: asset.sourceUrl,
      enabled: asset.enabled,
      capabilities,
      labels: asset.labels.map(({ label, position }) => ({
        id: label.id,
        name: label.name,
        description: label.description,
        position,
      })),
      image: asset.image ? { id: asset.image.id } : null,
      instant: asset.audioClip
        ? { id: asset.audioClip.id, volume: asset.audioClip.volume }
        : null,
      background: asset.backgroundAudio
        ? { defaultVolume: asset.backgroundAudio.defaultVolume }
        : null,
      song: asset.song
        ? {
            id: asset.song.id,
            artist: asset.song.artist,
            title: asset.song.title,
            coverUrl: asset.song.coverUrl,
            durationMs: asset.song.durationMs,
          }
        : null,
      coverForSongIds: asset.songCovers.map((song) => song.id),
      transition: asset.transition
        ? { id: asset.transition.id, cutPointMs: asset.transition.cutPointMs }
        : null,
      createdAt: asset.createdAt,
      updatedAt: asset.updatedAt,
    };
  }

  private mapLabel(label: MediaLabelRecord) {
    return {
      id: label.id,
      name: label.name,
      description: label.description,
      assetCount: label.assets.length,
      assets: label.assets.map(({ asset, position }) => ({
        position,
        asset: this.mapAsset(asset),
      })),
      createdAt: label.createdAt,
      updatedAt: label.updatedAt,
    };
  }

  private async syncLegacyGroupsFromLabels(
    tx: Prisma.TransactionClient,
    labelIds: string[],
  ): Promise<void> {
    for (const labelId of labelIds) {
      const mediaGroupId = this.legacyGroupId(labelId);
      if (mediaGroupId === null) continue;
      const assignments = await tx.mediaAssetLabel.findMany({
        where: { labelId },
        orderBy: { position: 'asc' },
        select: { asset: { select: { image: { select: { id: true } } } } },
      });
      const mediaIds = assignments
        .map((assignment) => assignment.asset.image?.id)
        .filter((mediaId): mediaId is number => mediaId !== undefined);
      await tx.mediaGroupItem.deleteMany({ where: { mediaGroupId } });
      if (mediaIds.length > 0) {
        await tx.mediaGroupItem.createMany({
          data: mediaIds.map((mediaId, position) => ({
            mediaGroupId,
            mediaId,
            position,
          })),
        });
      }
    }
  }

  private legacyGroupId(labelId: string): number | null {
    if (!labelId.startsWith(LEGACY_LABEL_PREFIX)) return null;
    const value = Number(labelId.slice(LEGACY_LABEL_PREFIX.length));
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  }

  private normalizeIds(value: unknown, field: string): string[] {
    if (!Array.isArray(value)) {
      throw new BadRequestException(`${field} must be an array`);
    }
    const ids: string[] = [];
    const seen = new Set<string>();
    for (const candidate of value) {
      const id = typeof candidate === 'string' ? candidate.trim() : '';
      if (!id) throw new BadRequestException(`${field} contains an invalid id`);
      if (!seen.has(id)) {
        ids.push(id);
        seen.add(id);
      }
    }
    return ids;
  }

  private assertIdsExist(
    requested: string[],
    existing: string[],
    kind: string,
  ): void {
    const found = new Set(existing);
    const missing = requested.filter((id) => !found.has(id));
    if (missing.length > 0) {
      throw new BadRequestException(`Unknown ${kind}: ${missing.join(', ')}`);
    }
  }

  private requiredId(value: unknown, field: string): string {
    return this.requiredString(value, field);
  }

  private requiredString(value: unknown, field: string): string {
    const normalized = typeof value === 'string' ? value.trim() : '';
    if (!normalized) throw new BadRequestException(`${field} is required`);
    return normalized;
  }

  private volume(value: unknown): number {
    const numeric = value === undefined ? 1 : Number(value);
    if (!Number.isFinite(numeric) || numeric < 0 || numeric > 1) {
      throw new BadRequestException('defaultVolume must be between 0 and 1');
    }
    return numeric;
  }

  private optionalString(value: unknown, field: string): string | null {
    if (value === undefined || value === null || value === '') return null;
    if (typeof value !== 'string') {
      throw new BadRequestException(`${field} must be a string or null`);
    }
    return value.trim() || null;
  }

  private rethrowUniqueName(error: unknown): never {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    ) {
      throw new BadRequestException('Media label name already exists');
    }
    throw error;
  }
}
