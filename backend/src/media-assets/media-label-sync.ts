import { Prisma } from '@prisma/client';

type MediaLabelSyncClient = Pick<
  Prisma.TransactionClient,
  'mediaLabel' | 'mediaAssetLabel'
>;

export interface LegacyMediaGroupLabelSource {
  id: number;
  name: string;
  description: string | null;
  createdAt?: Date;
  updatedAt?: Date;
  mediaItems: Array<{
    position: number;
    media: { assetId?: string | null };
  }>;
}

export function legacyMediaGroupLabelId(mediaGroupId: number): string {
  return `legacy-media-group:${mediaGroupId}`;
}

export async function syncLegacyMediaGroupLabel(
  tx: MediaLabelSyncClient,
  group: LegacyMediaGroupLabelSource,
): Promise<string> {
  const labelId = legacyMediaGroupLabelId(group.id);
  const timestamps = {
    ...(group.createdAt ? { createdAt: group.createdAt } : {}),
    ...(group.updatedAt ? { updatedAt: group.updatedAt } : {}),
  };

  await tx.mediaLabel.upsert({
    where: { id: labelId },
    create: {
      id: labelId,
      name: group.name,
      description: group.description,
      ...timestamps,
    },
    update: {
      name: group.name,
      description: group.description,
      ...(group.updatedAt ? { updatedAt: group.updatedAt } : {}),
    },
  });

  await tx.mediaAssetLabel.deleteMany({ where: { labelId } });
  const assignments = group.mediaItems.flatMap((item) =>
    item.media.assetId
      ? [
          {
            labelId,
            assetId: item.media.assetId,
            position: item.position,
          },
        ]
      : [],
  );
  if (assignments.length > 0) {
    await tx.mediaAssetLabel.createMany({ data: assignments });
  }

  return labelId;
}

export async function deleteLegacyMediaGroupLabel(
  tx: MediaLabelSyncClient,
  mediaGroupId: number,
): Promise<void> {
  await tx.mediaLabel.deleteMany({
    where: { id: legacyMediaGroupLabelId(mediaGroupId) },
  });
}
