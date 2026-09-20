import { MediaAssetKind, MediaAssetType } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { ALCANTARA_PERMISSIONS } from '../src/auth/permissions';
import { MediaAssetsService } from '../src/media-assets/media-assets.service';
import { ManagedMetricsService } from '../src/observability/managed-metrics.service';
import { PrismaService } from '../src/prisma.service';

const databaseUrl = process.env.DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe : describe.skip;

describeWithDatabase(
  'concurrent media label assignment (PostgreSQL e2e)',
  () => {
    let prisma: PrismaService;
    let service: MediaAssetsService;
    const labelId = `test-label:${randomUUID()}`;
    const assetIds = Array.from(
      { length: 12 },
      () => `test-image:${randomUUID()}`,
    );
    const authorization = {
      permissions: [
        ALCANTARA_PERMISSIONS.media.read,
        ALCANTARA_PERMISSIONS.media.manage,
      ],
    };

    beforeAll(async () => {
      const url = new URL(databaseUrl!);
      if (
        !['localhost', '127.0.0.1'].includes(url.hostname) ||
        url.pathname !== '/alcantara_ci'
      ) {
        throw new Error(
          'Media label concurrency test requires local CI PostgreSQL',
        );
      }
      prisma = new PrismaService();
      await prisma.$connect();
      service = new MediaAssetsService(prisma, new ManagedMetricsService());
      await prisma.mediaLabel.create({ data: { id: labelId, name: labelId } });
      await prisma.mediaAsset.createMany({
        data: assetIds.map((id, index) => ({
          id,
          kind: MediaAssetKind.IMAGE,
          mediaType: MediaAssetType.IMAGE,
          name: `Test image ${index + 1}`,
          sourceUrl: `https://media.invalid/test-${index + 1}.jpg`,
        })),
      });
    });

    afterAll(async () => {
      if (!prisma) return;
      await prisma.mediaLabel.deleteMany({ where: { id: labelId } });
      await prisma.mediaAsset.deleteMany({ where: { id: { in: assetIds } } });
      await prisma.$disconnect();
    });

    it('associates every simultaneous image and gives each a unique ordered position', async () => {
      const results = await Promise.all(
        assetIds.map((id) =>
          service.replaceAssetLabels(id, [labelId], authorization),
        ),
      );
      expect(results).toHaveLength(assetIds.length);
      expect(
        results.every((asset) =>
          asset.labels.some((label) => label.id === labelId),
        ),
      ).toBe(true);

      const label = await service.findLabel(labelId, authorization);
      expect(label.assetCount).toBe(assetIds.length);
      expect(new Set(label.assets.map(({ position }) => position)).size).toBe(
        assetIds.length,
      );
    }, 20_000);
  },
);
