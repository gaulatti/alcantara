import {
  deleteLegacyMediaGroupLabel,
  legacyMediaGroupLabelId,
  syncLegacyMediaGroupLabel,
} from './media-label-sync';

function transaction() {
  return {
    mediaLabel: { upsert: jest.fn(), deleteMany: jest.fn() },
    mediaAssetLabel: { deleteMany: jest.fn(), createMany: jest.fn() },
  };
}

describe('legacy media group label synchronization', () => {
  it('uses a reserved deterministic label id', () => {
    expect(legacyMediaGroupLabelId(42)).toBe('legacy-media-group:42');
  });

  it('replaces the ordered assignments with canonical asset ids', async () => {
    const tx = transaction();
    await syncLegacyMediaGroupLabel(tx as never, {
      id: 3,
      name: 'Morning slideshow',
      description: 'Opening stills',
      mediaItems: [
        { position: 0, media: { assetId: 'image:8' } },
        { position: 1, media: { assetId: null } },
        { position: 2, media: { assetId: 'image:13' } },
      ],
    });

    expect(tx.mediaAssetLabel.deleteMany).toHaveBeenCalledWith({
      where: { labelId: 'legacy-media-group:3' },
    });
    expect(tx.mediaAssetLabel.createMany).toHaveBeenCalledWith({
      data: [
        {
          labelId: 'legacy-media-group:3',
          assetId: 'image:8',
          position: 0,
        },
        {
          labelId: 'legacy-media-group:3',
          assetId: 'image:13',
          position: 2,
        },
      ],
    });
  });

  it('deletes only the reserved compatibility label', async () => {
    const tx = transaction();
    await deleteLegacyMediaGroupLabel(tx as never, 7);
    expect(tx.mediaLabel.deleteMany).toHaveBeenCalledWith({
      where: { id: 'legacy-media-group:7' },
    });
  });
});
