import { MediaAssetKind } from '@prisma/client';
import { StingersService } from './stingers.service';

describe('StingersService canonical asset writes', () => {
  it('creates a transition and its common asset identity atomically', async () => {
    const transition = {
      id: 4,
      assetId: 'transition:4',
      name: 'Wipe',
      videoUrl: 'https://media.test/wipe.webm',
      cutPointMs: 750,
      enabled: true,
    };
    const tx = {
      stinger: {
        create: jest.fn().mockResolvedValue({ ...transition, assetId: null }),
        update: jest.fn().mockResolvedValue(transition),
        findUniqueOrThrow: jest.fn().mockResolvedValue(transition),
      },
      mediaAsset: { upsert: jest.fn(), deleteMany: jest.fn() },
    };
    const prisma = {
      $transaction: jest.fn((operation: (client: typeof tx) => unknown) =>
        operation(tx),
      ),
    };
    const service = new StingersService(prisma as never);

    await expect(
      service.create({
        name: ' Wipe ',
        videoUrl: ' https://media.test/wipe.webm ',
        cutPointMs: 750,
      }),
    ).resolves.toEqual(transition);

    expect(tx.mediaAsset.upsert).toHaveBeenCalledWith({
      where: { id: 'transition:4' },
      create: {
        id: 'transition:4',
        kind: MediaAssetKind.TRANSITION,
        name: 'Wipe',
        sourceUrl: 'https://media.test/wipe.webm',
        enabled: true,
      },
      update: {
        kind: MediaAssetKind.TRANSITION,
        name: 'Wipe',
        sourceUrl: 'https://media.test/wipe.webm',
        enabled: true,
      },
    });
  });
});
