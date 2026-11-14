import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { MediaAssetType, Prisma } from '@prisma/client';
import { ALCANTARA_PERMISSIONS } from '../auth/permissions';
import { MediaAssetsService } from './media-assets.service';

const timestamp = new Date('2026-09-14T12:00:00.000Z');

function imageAsset(id = 'image:1') {
  return {
    id,
    kind: 'IMAGE',
    mediaType: MediaAssetType.IMAGE,
    name: 'Studio wide',
    sourceUrl: 'https://media.test/studio.jpg',
    enabled: true,
    image: {
      id: 1,
      name: 'Studio wide',
      imageUrl: 'https://media.test/studio.jpg',
    },
    audioClip: null,
    backgroundAudio: null,
    song: null,
    songCovers: [],
    transition: null,
    labels: [],
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function songAsset() {
  return {
    ...imageAsset('song:9'),
    kind: 'SONG',
    mediaType: MediaAssetType.AUDIO,
    name: 'Song title',
    sourceUrl: 'https://media.test/song.mp3',
    image: null,
    song: {
      id: 9,
      artist: 'Artist',
      title: 'Song title',
      coverUrl: null,
      durationMs: 180000,
    },
  };
}

function songCoverAsset() {
  return {
    ...imageAsset('song-cover:9'),
    kind: null,
    image: null,
    songCovers: [{ id: 9 }],
  };
}

function buildService() {
  const tx = {
    $queryRaw: jest.fn(),
    mediaAssetLabel: {
      findMany: jest.fn(),
      deleteMany: jest.fn(),
      createMany: jest.fn(),
      create: jest.fn(),
      aggregate: jest.fn(),
    },
    mediaGroupItem: { deleteMany: jest.fn(), createMany: jest.fn() },
    mediaLabel: {
      findUniqueOrThrow: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
    mediaGroup: { update: jest.fn(), delete: jest.fn() },
  };
  const prisma = {
    mediaAsset: {
      findMany: jest.fn(),
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
      delete: jest.fn(),
      count: jest.fn(),
    },
    mediaAssetLabel: { findMany: jest.fn() },
    mediaLabel: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
      count: jest.fn(),
    },
    $transaction: jest.fn((callback: (client: typeof tx) => unknown) =>
      callback(tx),
    ),
  };
  const metrics = { recordMediaLabelAssignment: jest.fn() };
  return {
    service: new MediaAssetsService(prisma as never, metrics as never),
    prisma,
    tx,
    metrics,
  };
}

describe('MediaAssetsService', () => {
  it('queries physical type and capability through the permission-scoped catalog', async () => {
    const { service, prisma } = buildService();
    prisma.mediaAsset.findMany.mockResolvedValue([songAsset()]);
    prisma.mediaAsset.count.mockResolvedValue(1);

    const result = await service.findAll(
      {
        mediaType: 'AUDIO',
        capability: 'SONG',
        page: 1,
        limit: 50,
      },
      { permissions: [ALCANTARA_PERMISSIONS.song.read] },
    );

    expect(prisma.mediaAsset.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          AND: [
            { OR: [{ song: { isNot: null } }] },
            { mediaType: MediaAssetType.AUDIO },
            { song: { isNot: null } },
          ],
        },
      }),
    );
    expect(result.data[0]).toMatchObject({
      id: 'song:9',
      mediaType: 'AUDIO',
      capabilities: ['SONG'],
      song: { id: 9, artist: 'Artist' },
    });
  });

  it('rejects label changes when the operator cannot manage the asset capability', async () => {
    const { service, prisma } = buildService();
    prisma.mediaAsset.findUnique.mockResolvedValue(songAsset());

    await expect(
      service.replaceAssetLabels('song:9', [], {
        permissions: [ALCANTARA_PERMISSIONS.media.manage],
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('locks a label before allocating its next position and records the committed assignment', async () => {
    const { service, prisma, tx, metrics } = buildService();
    prisma.mediaAsset.findUnique.mockResolvedValue(imageAsset());
    prisma.mediaAsset.findFirst.mockResolvedValue(imageAsset());
    prisma.mediaLabel.findMany.mockResolvedValue([{ id: 'label:1' }]);
    tx.mediaAssetLabel.findMany.mockResolvedValue([]);
    tx.mediaAssetLabel.aggregate.mockResolvedValue({ _max: { position: 7 } });

    await service.replaceAssetLabels('image:1', ['label:1'], {
      permissions: [ALCANTARA_PERMISSIONS.media.manage],
    });

    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(tx.$queryRaw.mock.calls[0][1]).toBe('label:1');
    expect(String(tx.$queryRaw.mock.calls[0][0])).toContain('FOR UPDATE');
    expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      tx.mediaAssetLabel.aggregate.mock.invocationCallOrder[0],
    );
    expect(tx.mediaAssetLabel.create).toHaveBeenCalledWith({
      data: { assetId: 'image:1', labelId: 'label:1', position: 8 },
    });
    expect(metrics.recordMediaLabelAssignment).toHaveBeenCalledWith('success');
  });

  it('rolls back a failed label assignment and records its failure', async () => {
    const { service, prisma, tx, metrics } = buildService();
    prisma.mediaAsset.findUnique.mockResolvedValue(imageAsset());
    prisma.mediaLabel.findMany.mockResolvedValue([{ id: 'label:1' }]);
    tx.mediaAssetLabel.findMany.mockResolvedValue([]);
    tx.mediaAssetLabel.aggregate.mockResolvedValue({ _max: { position: 7 } });
    tx.mediaAssetLabel.create.mockRejectedValue(new Error('write failed'));

    await expect(
      service.replaceAssetLabels('image:1', ['label:1'], {
        permissions: [ALCANTARA_PERMISSIONS.media.manage],
      }),
    ).rejects.toThrow('write failed');
    expect(metrics.recordMediaLabelAssignment).toHaveBeenCalledWith('failure');
  });

  it('creates standalone background audio without creating an Instant or Song', async () => {
    const { service, prisma } = buildService();
    prisma.mediaAsset.create.mockImplementation(
      ({ data }: { data: { id: string; name: string; sourceUrl: string } }) =>
        Promise.resolve({
          ...imageAsset(data.id),
          kind: null,
          mediaType: MediaAssetType.AUDIO,
          name: data.name,
          sourceUrl: data.sourceUrl,
          image: null,
          backgroundAudio: { assetId: data.id, defaultVolume: 0.6 },
        }),
    );

    const result = await service.createBackgroundAudio(
      {
        name: 'Night bed',
        sourceUrl: 'https://media.test/night.mp3',
        defaultVolume: 0.6,
      },
      { permissions: [ALCANTARA_PERMISSIONS.scene.manage] },
    );

    expect(prisma.mediaAsset.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          id: expect.stringMatching(/^media:/),
          mediaType: MediaAssetType.AUDIO,
          name: 'Night bed',
          sourceUrl: 'https://media.test/night.mp3',
          backgroundAudio: { create: { defaultVolume: 0.6 } },
        }),
      }),
    );
    expect(result).toMatchObject({
      mediaType: 'AUDIO',
      capabilities: ['BACKGROUND'],
      instant: null,
      song: null,
    });
  });

  it('exposes a song cover as an image asset with a derived cover capability', async () => {
    const { service, prisma } = buildService();
    prisma.mediaAsset.findMany.mockResolvedValue([songCoverAsset()]);
    prisma.mediaAsset.count.mockResolvedValue(1);

    const result = await service.findAll(
      { mediaType: 'IMAGE', capability: 'COVER', page: 1, limit: 50 },
      { permissions: [ALCANTARA_PERMISSIONS.media.read] },
    );

    expect(result.data[0]).toMatchObject({
      id: 'song-cover:9',
      mediaType: 'IMAGE',
      capabilities: ['COVER'],
      coverForSongIds: [9],
    });
  });

  it('preserves label order when mirroring an imported slideshow label', async () => {
    const { service, prisma, tx } = buildService();
    const first = imageAsset('image:1');
    const second = {
      ...imageAsset('image:2'),
      image: {
        id: 2,
        name: 'Second',
        imageUrl: 'https://media.test/second.jpg',
      },
    };
    prisma.mediaLabel.findUnique.mockResolvedValue({
      id: 'legacy-media-group:4',
    });
    prisma.mediaAssetLabel.findMany.mockResolvedValue([]);
    prisma.mediaAsset.findMany.mockResolvedValue([first, second]);
    tx.mediaAssetLabel.findMany.mockResolvedValue([
      { asset: { image: { id: 2 } } },
      { asset: { image: { id: 1 } } },
    ]);
    jest
      .spyOn(service, 'findLabel')
      .mockResolvedValue({ id: 'legacy-media-group:4' } as never);

    await service.replaceLabelAssets(
      'legacy-media-group:4',
      ['image:2', 'image:1'],
      { permissions: [ALCANTARA_PERMISSIONS.media.manage] },
    );

    expect(tx.$queryRaw.mock.calls[0][1]).toBe('legacy-media-group:4');
    expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      tx.mediaAssetLabel.deleteMany.mock.invocationCallOrder[0],
    );

    expect(tx.mediaAssetLabel.createMany).toHaveBeenCalledWith({
      data: [
        { labelId: 'legacy-media-group:4', assetId: 'image:2', position: 0 },
        { labelId: 'legacy-media-group:4', assetId: 'image:1', position: 1 },
      ],
    });
    expect(tx.mediaGroupItem.createMany).toHaveBeenCalledWith({
      data: [
        { mediaGroupId: 4, mediaId: 2, position: 0 },
        { mediaGroupId: 4, mediaId: 1, position: 1 },
      ],
    });
  });

  it('resolves only ordered enabled image URLs for public slideshow playback', async () => {
    const { service, prisma } = buildService();
    prisma.mediaLabel.findUnique.mockResolvedValue({
      id: 'label-1',
      name: 'Headlines',
      assets: [
        {
          position: 0,
          asset: { id: 'image:2', name: 'Two', sourceUrl: 'two.jpg' },
        },
        {
          position: 1,
          asset: { id: 'image:1', name: 'One', sourceUrl: 'one.jpg' },
        },
      ],
    });

    await expect(service.resolveLabelImages('label-1')).resolves.toEqual({
      id: 'label-1',
      name: 'Headlines',
      images: [
        { assetId: 'image:2', name: 'Two', imageUrl: 'two.jpg', position: 0 },
        { assetId: 'image:1', name: 'One', imageUrl: 'one.jpg', position: 1 },
      ],
    });
  });

  it('fails closed when a requested label does not exist', async () => {
    const { service, prisma } = buildService();
    prisma.mediaLabel.findUnique.mockResolvedValue(null);
    await expect(service.resolveLabelImages('missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

const catalogAuthority = { permissions: ['*'] };
function lifecycleHarness() {
  const f = buildService();
  const label = {
    id: 'label-1',
    name: 'Headlines',
    description: null,
    assets: [],
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  f.prisma.mediaAsset.findFirst.mockResolvedValue(imageAsset());
  f.prisma.mediaAsset.findUnique.mockResolvedValue(imageAsset());
  f.prisma.mediaAsset.findMany.mockResolvedValue([imageAsset()]);
  f.prisma.mediaAsset.count.mockResolvedValue(1);
  f.prisma.mediaAssetLabel.findMany.mockResolvedValue([]);
  f.prisma.mediaLabel.findUnique.mockResolvedValue(label);
  f.prisma.mediaLabel.findMany.mockResolvedValue([label]);
  f.prisma.mediaLabel.count.mockResolvedValue(1);
  f.prisma.mediaLabel.create.mockImplementation(async ({ data }) => ({
    ...label,
    ...data,
  }));
  f.tx.mediaLabel.findUniqueOrThrow.mockResolvedValue(label);
  f.tx.mediaAssetLabel.findMany.mockResolvedValue([]);
  f.tx.mediaAssetLabel.aggregate.mockResolvedValue({
    _max: { position: null },
  });
  return { ...f, label };
}

describe('MediaAssetsService catalog mutation and compatibility boundaries', () => {
  it('combines trimmed search, physical type and label filters with the permission-scoped source inventory', async () => {
    const f = lifecycleHarness();
    const result = await f.service.findAll(
      {
        search: ' Studio ',
        mediaType: 'IMAGE',
        labelId: ' label-1 ',
        page: 2,
        limit: 10,
      },
      catalogAuthority,
    );
    expect(result.meta).toEqual({
      total: 1,
      page: 2,
      limit: 10,
      totalPages: 1,
    });
    expect(f.prisma.mediaAsset.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          AND: [
            {},
            { name: { contains: 'Studio', mode: 'insensitive' } },
            { mediaType: 'IMAGE' },
            { labels: { some: { labelId: 'label-1' } } },
          ],
        },
        skip: 10,
        take: 10,
      }),
    );
  });

  it.each([
    ['INSTANT', { audioClip: { isNot: null } }],
    ['BACKGROUND', { backgroundAudio: { isNot: null } }],
    ['SONG', { song: { isNot: null } }],
    ['COVER', { songCovers: { some: {} } }],
    ['TRANSITION', { transition: { isNot: null } }],
  ] as const)(
    'filters the real %s capability without using filename inference',
    async (capability, expected) => {
      const f = lifecycleHarness();
      expect(
        (
          await f.service.findAll(
            { capability: ` ${capability.toLowerCase()} `, page: 1, limit: 20 },
            catalogAuthority,
          )
        ).data,
      ).toHaveLength(1);
      expect(f.prisma.mediaAsset.count).toHaveBeenCalledWith({
        where: expect.objectContaining({
          AND: [{}, expected],
        }),
      });
    },
  );

  it.each([{ mediaType: 'document' }, { capability: 'MUSIC_FILE' }])(
    'rejects unsupported catalog type/capability before querying: %p',
    async (filter) => {
      const f = lifecycleHarness();
      await expect(
        f.service.findAll({ ...filter, page: 1, limit: 20 }, catalogAuthority),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(f.prisma.mediaAsset.findMany).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['IMAGE', 'IMAGE'],
    ['TRANSITION', 'VIDEO'],
    ['AUDIO_CLIP', 'AUDIO'],
    ['SONG', 'AUDIO'],
  ])(
    'preserves legacy %s physical-type fallback as %s',
    async (kind, mediaType) => {
      const f = lifecycleHarness();
      f.prisma.mediaAsset.findFirst.mockResolvedValue({
        ...imageAsset(),
        kind,
        mediaType: null,
      });
      expect(
        await f.service.findOne('image:1', catalogAuthority),
      ).toMatchObject({ mediaType });
    },
  );

  it('fails closed on a legacy asset with neither a physical type nor a recognizable kind', async () => {
    const f = lifecycleHarness();
    f.prisma.mediaAsset.findFirst.mockResolvedValue({
      ...imageAsset(),
      kind: null,
      mediaType: null,
    });
    await expect(
      f.service.findOne('image:1', catalogAuthority),
    ).rejects.toThrow('has no physical type');
    f.prisma.mediaAsset.findFirst.mockResolvedValue(null);
    await expect(
      f.service.findOne('missing', catalogAuthority),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('presents all persisted media capabilities and ordered label assignments without losing native metadata', async () => {
    const f = lifecycleHarness();
    f.prisma.mediaAsset.findFirst.mockResolvedValue({
      ...songAsset(),
      audioClip: { id: 8, volume: 0.5 },
      backgroundAudio: { defaultVolume: 0.25 },
      songCovers: [{ id: 9 }],
      transition: { id: 'transition-a', cutPointMs: 400 },
      labels: [
        {
          label: {
            id: 'label-1',
            name: 'Headlines',
            description: 'Desk images',
          },
          position: 3,
        },
      ],
    });
    expect(await f.service.findOne('song:9', catalogAuthority)).toMatchObject({
      capabilities: ['INSTANT', 'BACKGROUND', 'SONG', 'COVER', 'TRANSITION'],
      instant: { id: 8, volume: 0.5 },
      background: { defaultVolume: 0.25 },
      coverForSongIds: [9],
      transition: { id: 'transition-a', cutPointMs: 400 },
      labels: [
        {
          id: 'label-1',
          name: 'Headlines',
          description: 'Desk images',
          position: 3,
        },
      ],
    });
  });

  it.each([undefined, 0, 1, '0.4'])(
    'stores the supported native background volume: %p',
    async (volume) => {
      const f = lifecycleHarness();
      f.prisma.mediaAsset.create.mockImplementation(async ({ data }) => ({
        ...imageAsset(data.id),
        kind: null,
        mediaType: 'AUDIO',
        image: null,
        backgroundAudio: {
          defaultVolume: data.backgroundAudio.create.defaultVolume,
        },
      }));
      const result = await f.service.createBackgroundAudio(
        {
          name: 'Bed',
          sourceUrl: 'https://media.test/bed.mp3',
          defaultVolume: volume,
        },
        catalogAuthority,
      );
      expect(result.background?.defaultVolume).toBe(
        volume === undefined ? 1 : Number(volume),
      );
    },
  );

  it.each([-0.1, 1.1, NaN, 'invalid'])(
    'rejects an invalid background volume before creating any asset: %p',
    async (defaultVolume) => {
      const f = lifecycleHarness();
      await expect(
        f.service.createBackgroundAudio(
          {
            name: 'Bed',
            sourceUrl: 'https://media.test/bed.mp3',
            defaultVolume,
          },
          catalogAuthority,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(f.prisma.mediaAsset.create).not.toHaveBeenCalled();
    },
  );

  it('removes only standalone assets and sends capability-owned assets to their own deletion boundary', async () => {
    const f = lifecycleHarness();
    f.prisma.mediaAsset.findUnique.mockResolvedValueOnce({
      ...imageAsset('bed'),
      image: null,
      mediaType: 'AUDIO',
      backgroundAudio: { defaultVolume: 1 },
    });
    expect(
      await f.service.removeStandaloneAsset(' bed ', catalogAuthority),
    ).toEqual({ deletedMediaAssetId: 'bed' });
    expect(f.prisma.mediaAsset.delete).toHaveBeenCalledWith({
      where: { id: 'bed' },
    });
    for (const shape of [
      imageAsset(),
      songAsset(),
      songCoverAsset(),
      { ...imageAsset(), image: null, audioClip: { id: 8 } },
      { ...imageAsset(), image: null, transition: { id: 'transition-a' } },
    ]) {
      f.prisma.mediaAsset.findUnique.mockResolvedValueOnce(shape);
      await expect(
        f.service.removeStandaloneAsset(shape.id, catalogAuthority),
      ).rejects.toThrow('capability-specific editor');
    }
    f.prisma.mediaAsset.findUnique.mockResolvedValueOnce(null);
    await expect(
      f.service.removeStandaloneAsset('missing', catalogAuthority),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(f.prisma.mediaAsset.delete).toHaveBeenCalledTimes(1);
  });

  it.each([undefined, 'label-1', [7], [' ']].map((value) => [value] as const))(
    'rejects malformed label assignment ids before replacing existing membership: %p',
    async (ids) => {
      const f = lifecycleHarness();
      await expect(
        f.service.replaceAssetLabels('image:1', ids, catalogAuthority),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(f.tx.mediaAssetLabel.deleteMany).not.toHaveBeenCalled();
    },
  );

  it('retains an existing label position and deduplicates repeated assignments instead of appending duplicates', async () => {
    const f = lifecycleHarness();
    f.tx.mediaAssetLabel.findMany.mockResolvedValue([
      { labelId: 'label-1', position: 7 },
    ]);
    await f.service.replaceAssetLabels(
      'image:1',
      [' label-1 ', 'label-1'],
      catalogAuthority,
    );
    expect(f.tx.mediaAssetLabel.create).toHaveBeenCalledWith({
      data: { assetId: 'image:1', labelId: 'label-1', position: 7 },
    });
    expect(f.tx.mediaAssetLabel.aggregate).not.toHaveBeenCalled();
    expect(f.metrics.recordMediaLabelAssignment).toHaveBeenCalledWith(
      'success',
    );
  });

  it('rejects missing assets, unknown labels and non-image legacy slideshow assignments before any transaction', async () => {
    const f = lifecycleHarness();
    f.prisma.mediaAsset.findUnique.mockResolvedValueOnce(null);
    await expect(
      f.service.replaceAssetLabels('missing', ['label-1'], catalogAuthority),
    ).rejects.toBeInstanceOf(NotFoundException);
    f.prisma.mediaLabel.findMany.mockResolvedValueOnce([]);
    await expect(
      f.service.replaceAssetLabels('image:1', ['unknown'], catalogAuthority),
    ).rejects.toThrow('Unknown labels: unknown');
    f.prisma.mediaAsset.findUnique.mockResolvedValueOnce(songAsset());
    f.prisma.mediaLabel.findMany.mockResolvedValueOnce([
      { id: 'legacy-media-group:4' },
    ]);
    await expect(
      f.service.replaceAssetLabels(
        'song:9',
        ['legacy-media-group:4'],
        catalogAuthority,
      ),
    ).rejects.toThrow('only image assets');
    expect(f.prisma.$transaction).not.toHaveBeenCalled();
  });

  it('lists labels with search and truthful pagination while restricting their asset rows by read permissions', async () => {
    const f = lifecycleHarness();
    f.label.assets = [{ asset: imageAsset(), position: 4 }] as any;
    const result = await f.service.findLabels(
      { search: ' Headlines ', page: 2, limit: 5 },
      catalogAuthority,
    );
    expect(result).toMatchObject({
      data: [
        {
          id: 'label-1',
          assetCount: 1,
          assets: [{ position: 4, asset: { id: 'image:1' } }],
        },
      ],
      meta: { page: 2, limit: 5, total: 1, totalPages: 1 },
    });
    expect(f.prisma.mediaLabel.count).toHaveBeenCalledWith({
      where: { name: { contains: 'Headlines', mode: 'insensitive' } },
    });
    await f.service.findLabels({ page: 1, limit: 20 }, catalogAuthority);
    expect(f.prisma.mediaLabel.count).toHaveBeenLastCalledWith({ where: {} });
  });

  it.each([undefined, null, '', '   '])(
    'normalizes an absent label description without losing its name: %p',
    async (description) => {
      const f = lifecycleHarness();
      expect(
        await f.service.createLabel(
          { name: ' Headlines ', description },
          catalogAuthority,
        ),
      ).toMatchObject({ name: 'Headlines', description: null });
    },
  );

  it('preserves explicit label descriptions and rejects missing names, invalid ids and non-text descriptions', async () => {
    const f = lifecycleHarness();
    expect(
      await f.service.createLabel(
        { name: 'Headlines', description: ' Desk images ' },
        catalogAuthority,
      ),
    ).toMatchObject({ description: 'Desk images' });
    await expect(
      f.service.createLabel({ name: 7 }, catalogAuthority),
    ).rejects.toThrow('name is required');
    await expect(
      f.service.createLabel(
        { name: 'Headlines', description: 7 },
        catalogAuthority,
      ),
    ).rejects.toThrow('description must be a string or null');
    await expect(f.service.findOne(' ', catalogAuthority)).rejects.toThrow(
      'asset id is required',
    );
  });

  it.each(['create', 'update'] as const)(
    'maps only actual label uniqueness conflicts during %s and preserves unrelated storage errors',
    async (operation) => {
      const f = lifecycleHarness();
      const failure = new Error('label storage unavailable');
      const query =
        operation === 'create'
          ? f.prisma.mediaLabel.create
          : f.prisma.$transaction;
      const invoke = () =>
        operation === 'create'
          ? f.service.createLabel({ name: 'Headlines' }, catalogAuthority)
          : f.service.updateLabel(
              'label-1',
              { name: 'Headlines' },
              catalogAuthority,
            );
      query.mockRejectedValueOnce(
        new Prisma.PrismaClientKnownRequestError('duplicate', {
          code: 'P2002',
          clientVersion: 'test',
        }),
      );
      await expect(invoke()).rejects.toThrow('Media label name already exists');
      query.mockRejectedValueOnce(failure);
      await expect(invoke()).rejects.toBe(failure);
    },
  );

  it('edits an ordinary label without touching any legacy group and allows an explicit no-op update', async () => {
    const f = lifecycleHarness();
    await f.service.updateLabel(
      'label-1',
      { name: 'New', description: null },
      catalogAuthority,
    );
    expect(f.tx.mediaLabel.update).toHaveBeenCalledWith({
      where: { id: 'label-1' },
      data: { name: 'New', description: null },
    });
    expect(f.tx.mediaGroup.update).not.toHaveBeenCalled();
    f.tx.mediaLabel.update.mockClear();
    await f.service.updateLabel('label-1', {}, catalogAuthority);
    expect(f.tx.mediaLabel.update).not.toHaveBeenCalled();
  });

  it('mirrors separate imported label name and description edits into the same legacy slideshow group', async () => {
    const f = lifecycleHarness();
    await f.service.updateLabel(
      'legacy-media-group:4',
      { name: 'New' },
      catalogAuthority,
    );
    expect(f.tx.mediaGroup.update).toHaveBeenLastCalledWith({
      where: { id: 4 },
      data: { name: 'New' },
    });
    await f.service.updateLabel(
      'legacy-media-group:4',
      { description: ' Updated ' },
      catalogAuthority,
    );
    expect(f.tx.mediaGroup.update).toHaveBeenLastCalledWith({
      where: { id: 4 },
      data: { description: 'Updated' },
    });
  });

  it('clears ordered label assets explicitly without inventing replacement membership', async () => {
    const f = lifecycleHarness();
    expect(
      await f.service.replaceLabelAssets('label-1', [], catalogAuthority),
    ).toMatchObject({ id: 'label-1', assetCount: 0 });
    expect(f.tx.mediaAssetLabel.deleteMany).toHaveBeenCalledWith({
      where: { labelId: 'label-1' },
    });
    expect(f.tx.mediaAssetLabel.createMany).not.toHaveBeenCalled();
  });

  it('refuses missing labels or unknown replacement assets before deleting current membership', async () => {
    const f = lifecycleHarness();
    f.prisma.mediaLabel.findUnique.mockResolvedValueOnce(null);
    await expect(
      f.service.replaceLabelAssets('missing', [], catalogAuthority),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      f.service.replaceLabelAssets('label-1', ['unknown'], catalogAuthority),
    ).rejects.toThrow('Unknown assets: unknown');
    expect(f.tx.mediaAssetLabel.deleteMany).not.toHaveBeenCalled();
  });

  it('keeps imported slideshow labels restricted to backed image assets', async () => {
    const f = lifecycleHarness();
    f.prisma.mediaAsset.findMany.mockResolvedValueOnce([songAsset()]);
    await expect(
      f.service.replaceLabelAssets(
        'legacy-media-group:4',
        ['song:9'],
        catalogAuthority,
      ),
    ).rejects.toThrow('only image assets');
    f.prisma.mediaAsset.findMany.mockResolvedValueOnce([songCoverAsset()]);
    await expect(
      f.service.replaceLabelAssets(
        'legacy-media-group:4',
        ['song-cover:9'],
        catalogAuthority,
      ),
    ).rejects.toThrow('only image assets');
    expect(f.tx.mediaAssetLabel.deleteMany).not.toHaveBeenCalled();
  });

  it.each(['legacy-media-group:0', 'legacy-media-group:1.5', 'ordinary-label'])(
    'deletes a non-imported label without deleting an unrelated legacy group: %s',
    async (labelId) => {
      const f = lifecycleHarness();
      expect(await f.service.removeLabel(labelId, catalogAuthority)).toEqual({
        deletedMediaLabelId: labelId,
      });
      expect(f.tx.mediaLabel.delete).toHaveBeenCalledWith({
        where: { id: labelId },
      });
      expect(f.tx.mediaGroup.delete).not.toHaveBeenCalled();
    },
  );

  it('deletes an imported label through its owning legacy group and rejects missing labels before mutation', async () => {
    const f = lifecycleHarness();
    await f.service.removeLabel('legacy-media-group:4', catalogAuthority);
    expect(f.tx.mediaGroup.delete).toHaveBeenCalledWith({ where: { id: 4 } });
    f.prisma.mediaLabel.findUnique.mockResolvedValue(null);
    await expect(
      f.service.updateLabel('missing', {}, catalogAuthority),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      f.service.removeLabel('missing', catalogAuthority),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
