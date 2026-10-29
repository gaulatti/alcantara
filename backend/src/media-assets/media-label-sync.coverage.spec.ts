import {
  deleteLegacyMediaGroupLabel,
  legacyMediaGroupLabelId,
  syncLegacyMediaGroupLabel,
} from './media-label-sync';

function buildTx() {
  return {
    mediaLabel: { upsert: jest.fn(), deleteMany: jest.fn() },
    mediaAssetLabel: { deleteMany: jest.fn(), createMany: jest.fn() },
  };
}

describe('media label sync (coverage)', () => {
  it('copies createdAt and updatedAt when the group provides them', async () => {
    const tx = buildTx();
    const createdAt = new Date('2026-01-01T00:00:00Z');
    const updatedAt = new Date('2026-02-01T00:00:00Z');

    await expect(
      syncLegacyMediaGroupLabel(tx as never, {
        id: 5,
        name: 'News',
        description: 'desc',
        createdAt,
        updatedAt,
        mediaItems: [
          { position: 0, media: { assetId: 'image:1' } },
          { position: 1, media: { assetId: null } },
          { position: 2, media: {} },
          { position: 3, media: { assetId: 'image:4' } },
        ],
      }),
    ).resolves.toBe('legacy-media-group:5');

    expect(tx.mediaLabel.upsert).toHaveBeenCalledWith({
      where: { id: 'legacy-media-group:5' },
      create: {
        id: 'legacy-media-group:5',
        name: 'News',
        description: 'desc',
        createdAt,
        updatedAt,
      },
      update: { name: 'News', description: 'desc', updatedAt },
    });
    expect(tx.mediaAssetLabel.deleteMany).toHaveBeenCalledWith({
      where: { labelId: 'legacy-media-group:5' },
    });
    expect(tx.mediaAssetLabel.createMany).toHaveBeenCalledWith({
      data: [
        { labelId: 'legacy-media-group:5', assetId: 'image:1', position: 0 },
        { labelId: 'legacy-media-group:5', assetId: 'image:4', position: 3 },
      ],
    });
  });

  it('omits timestamps and skips assignments when none apply', async () => {
    const tx = buildTx();

    await syncLegacyMediaGroupLabel(tx as never, {
      id: 6,
      name: 'Empty',
      description: null,
      mediaItems: [{ position: 0, media: { assetId: null } }],
    });

    expect(tx.mediaLabel.upsert).toHaveBeenCalledWith({
      where: { id: 'legacy-media-group:6' },
      create: { id: 'legacy-media-group:6', name: 'Empty', description: null },
      update: { name: 'Empty', description: null },
    });
    expect(tx.mediaAssetLabel.createMany).not.toHaveBeenCalled();
  });

  it('copies only createdAt when updatedAt is missing, and only updatedAt when createdAt is missing', async () => {
    const tx = buildTx();
    const date = new Date('2026-03-01T00:00:00Z');

    await syncLegacyMediaGroupLabel(tx as never, {
      id: 7,
      name: 'A',
      description: null,
      createdAt: date,
      mediaItems: [],
    });
    await syncLegacyMediaGroupLabel(tx as never, {
      id: 8,
      name: 'B',
      description: null,
      updatedAt: date,
      mediaItems: [],
    });

    expect(tx.mediaLabel.upsert.mock.calls[0][0].create).toEqual({
      id: 'legacy-media-group:7',
      name: 'A',
      description: null,
      createdAt: date,
    });
    expect(tx.mediaLabel.upsert.mock.calls[1][0].create).toEqual({
      id: 'legacy-media-group:8',
      name: 'B',
      description: null,
      updatedAt: date,
    });
  });

  it('deletes the legacy label by deterministic id', async () => {
    const tx = buildTx();
    await deleteLegacyMediaGroupLabel(tx as never, 9);
    expect(legacyMediaGroupLabelId(9)).toBe('legacy-media-group:9');
    expect(tx.mediaLabel.deleteMany).toHaveBeenCalledWith({
      where: { id: 'legacy-media-group:9' },
    });
  });
});
