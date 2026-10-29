import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { MediaAssetKind, MediaAssetType, Prisma } from '@prisma/client';
import { ALCANTARA_PERMISSIONS as P } from '../auth/permissions';
import { MediaAssetsService } from './media-assets.service';

const ts = new Date('2026-09-14T12:00:00.000Z');
const ALL = { permissions: ['*'] };

function asset(overrides: Record<string, unknown> = {}) {
  return {
    id: 'image:1',
    kind: MediaAssetKind.IMAGE,
    mediaType: MediaAssetType.IMAGE,
    name: 'Asset',
    sourceUrl: 'https://media.test/a',
    enabled: true,
    image: { id: 1 },
    audioClip: null,
    backgroundAudio: null,
    song: null,
    songCovers: [],
    transition: null,
    labels: [],
    createdAt: ts,
    updatedAt: ts,
    ...overrides,
  };
}

function standalone(overrides: Record<string, unknown> = {}) {
  return asset({
    id: 'media:abc',
    kind: null,
    mediaType: MediaAssetType.AUDIO,
    image: null,
    backgroundAudio: { defaultVolume: 0.5 },
    ...overrides,
  });
}

function buildService() {
  const tx = {
    $queryRaw: jest.fn(),
    mediaAssetLabel: {
      findMany: jest.fn().mockResolvedValue([]),
      deleteMany: jest.fn(),
      createMany: jest.fn(),
      create: jest.fn(),
      aggregate: jest.fn().mockResolvedValue({ _max: { position: null } }),
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
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
      delete: jest.fn(),
      count: jest.fn().mockResolvedValue(0),
    },
    mediaAssetLabel: { findMany: jest.fn().mockResolvedValue([]) },
    mediaLabel: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn(),
      create: jest.fn(),
      count: jest.fn().mockResolvedValue(0),
    },
    $transaction: jest.fn((callback: (client: typeof tx) => unknown) =>
      callback(tx),
    ) as jest.Mock,
  };
  const metrics = { recordMediaLabelAssignment: jest.fn() };
  return {
    service: new MediaAssetsService(prisma as never, metrics as never),
    prisma,
    tx,
    metrics,
  };
}

function labelRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: 'l1',
    name: 'Label',
    description: null,
    createdAt: ts,
    updatedAt: ts,
    assets: [],
    ...overrides,
  };
}

function p2002() {
  return new Prisma.PrismaClientKnownRequestError('dup', {
    code: 'P2002',
    clientVersion: 'test',
  });
}

describe('MediaAssetsService (coverage)', () => {
  describe('findAll', () => {
    it('applies every filter and paginates', async () => {
      const { service, prisma } = buildService();
      prisma.mediaAsset.findMany.mockResolvedValue([asset()]);
      prisma.mediaAsset.count.mockResolvedValue(7);

      const result = await service.findAll(
        {
          search: ' still ',
          mediaType: 'IMAGE',
          capability: ' instant ',
          labelId: ' l1 ',
          page: 2,
          limit: 3,
        },
        { permissions: [P.instant.read] },
      );

      expect(prisma.mediaAsset.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            AND: [
              { OR: [{ audioClip: { isNot: null } }] },
              { name: { contains: 'still', mode: 'insensitive' } },
              { mediaType: 'IMAGE' },
              { audioClip: { isNot: null } },
              { labels: { some: { labelId: 'l1' } } },
            ],
          },
          orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
          skip: 3,
          take: 3,
        }),
      );
      expect(result.meta).toEqual({
        total: 7,
        page: 2,
        limit: 3,
        totalPages: 3,
      });
      expect(result.data).toHaveLength(1);
    });

    it('skips optional filters when absent or blank', async () => {
      const { service, prisma } = buildService();
      await service.findAll(
        { search: '  ', labelId: '   ', page: 1, limit: 10 },
        ALL,
      );
      await service.findAll({ page: 1, limit: 10 }, ALL);
      for (const call of prisma.mediaAsset.findMany.mock.calls) {
        expect(call[0].where).toEqual({ AND: [{}] });
      }
    });

    it('rejects an unknown mediaType', async () => {
      const { service, prisma } = buildService();
      await expect(
        service.findAll({ mediaType: 'DOC', page: 1, limit: 1 }, ALL),
      ).rejects.toThrow(new BadRequestException('Unknown mediaType'));
      expect(prisma.mediaAsset.findMany).not.toHaveBeenCalled();
    });

    it.each([
      ['INSTANT', { audioClip: { isNot: null } }],
      ['background', { backgroundAudio: { isNot: null } }],
      ['SONG', { song: { isNot: null } }],
      ['Cover', { songCovers: { some: {} } }],
      ['TRANSITION', { transition: { isNot: null } }],
    ])('maps capability %s', async (capability, expected) => {
      const { service, prisma } = buildService();
      await service.findAll({ capability, page: 1, limit: 1 }, ALL);
      expect(prisma.mediaAsset.findMany.mock.calls[0][0].where).toEqual({
        AND: [{}, expected],
      });
    });

    it('rejects an unknown capability', async () => {
      const { service } = buildService();
      await expect(
        service.findAll({ capability: 'nope', page: 1, limit: 1 }, ALL),
      ).rejects.toThrow(new BadRequestException('Unknown capability'));
    });
  });

  describe('mapAsset / findOne', () => {
    it('maps every capability and label', async () => {
      const { service, prisma } = buildService();
      prisma.mediaAsset.findFirst.mockResolvedValue(
        asset({
          id: 'x',
          audioClip: { id: 2, volume: 0.4 },
          backgroundAudio: { defaultVolume: 0.9 },
          song: {
            id: 3,
            artist: 'A',
            title: 'T',
            coverUrl: 'c',
            durationMs: 10,
          },
          songCovers: [{ id: 3 }, { id: 4 }],
          transition: { id: 5, cutPointMs: 100 },
          labels: [
            {
              position: 2,
              label: { id: 'l', name: 'L', description: 'd' },
            },
          ],
        }),
      );
      await expect(service.findOne(' x ', ALL)).resolves.toEqual({
        id: 'x',
        mediaType: MediaAssetType.IMAGE,
        name: 'Asset',
        sourceUrl: 'https://media.test/a',
        enabled: true,
        capabilities: ['INSTANT', 'BACKGROUND', 'SONG', 'COVER', 'TRANSITION'],
        labels: [{ id: 'l', name: 'L', description: 'd', position: 2 }],
        image: { id: 1 },
        instant: { id: 2, volume: 0.4 },
        background: { defaultVolume: 0.9 },
        song: { id: 3, artist: 'A', title: 'T', coverUrl: 'c', durationMs: 10 },
        coverForSongIds: [3, 4],
        transition: { id: 5, cutPointMs: 100 },
        createdAt: ts,
        updatedAt: ts,
      });
      expect(prisma.mediaAsset.findFirst.mock.calls[0][0].where).toEqual({
        AND: [{ id: 'x' }, {}],
      });
    });

    it('maps an asset with no capabilities to nulls', async () => {
      const { service, prisma } = buildService();
      prisma.mediaAsset.findFirst.mockResolvedValue(asset({ image: null }));
      const mapped = await service.findOne('image:1', ALL);
      expect(mapped).toMatchObject({
        capabilities: [],
        image: null,
        instant: null,
        background: null,
        song: null,
        coverForSongIds: [],
        transition: null,
      });
    });

    it.each([
      [MediaAssetKind.IMAGE, MediaAssetType.IMAGE],
      [MediaAssetKind.TRANSITION, MediaAssetType.VIDEO],
      [MediaAssetKind.AUDIO_CLIP, MediaAssetType.AUDIO],
      [MediaAssetKind.SONG, MediaAssetType.AUDIO],
    ])(
      'derives the physical type of %s assets lacking mediaType',
      async (kind, type) => {
        const { service, prisma } = buildService();
        prisma.mediaAsset.findFirst.mockResolvedValue(
          asset({ kind, mediaType: null }),
        );
        await expect(service.findOne('a', ALL)).resolves.toMatchObject({
          mediaType: type,
        });
      },
    );

    it('fails for an asset with neither mediaType nor kind', async () => {
      const { service, prisma } = buildService();
      prisma.mediaAsset.findFirst.mockResolvedValue(
        asset({ kind: null, mediaType: null }),
      );
      await expect(service.findOne('a', ALL)).rejects.toThrow(
        'Media asset null has no physical type',
      );
    });

    it('throws NotFound when missing and BadRequest for blank ids', async () => {
      const { service, prisma } = buildService();
      prisma.mediaAsset.findFirst.mockResolvedValue(null);
      await expect(service.findOne('a', ALL)).rejects.toThrow(
        new NotFoundException('Media asset not found'),
      );
      await expect(service.findOne('  ', ALL)).rejects.toThrow(
        new BadRequestException('asset id is required'),
      );
      await expect(
        service.findOne(5 as unknown as string, ALL),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('createBackgroundAudio', () => {
    it('requires scene management', async () => {
      const { service, prisma } = buildService();
      await expect(
        service.createBackgroundAudio(
          { name: 'n', sourceUrl: 'u' },
          { permissions: [] },
        ),
      ).rejects.toThrow(ForbiddenException);
      expect(prisma.mediaAsset.create).not.toHaveBeenCalled();
    });

    it('creates the asset with default and explicit volume', async () => {
      const { service, prisma } = buildService();
      prisma.mediaAsset.create.mockResolvedValue(standalone());
      const auth = { permissions: [P.scene.manage] };

      await service.createBackgroundAudio(
        { name: ' Bed ', sourceUrl: ' u ' },
        auth,
      );
      await service.createBackgroundAudio(
        { name: 'Bed', sourceUrl: 'u', defaultVolume: '0.25' },
        auth,
      );
      await service.createBackgroundAudio(
        { name: 'Bed', sourceUrl: 'u', defaultVolume: 0 },
        auth,
      );

      const data = prisma.mediaAsset.create.mock.calls.map((c) => c[0].data);
      expect(data[0]).toEqual({
        id: expect.stringMatching(/^media:[0-9a-f-]{36}$/),
        mediaType: MediaAssetType.AUDIO,
        name: 'Bed',
        sourceUrl: 'u',
        backgroundAudio: { create: { defaultVolume: 1 } },
      });
      expect(data[1].backgroundAudio).toEqual({
        create: { defaultVolume: 0.25 },
      });
      expect(data[2].backgroundAudio).toEqual({ create: { defaultVolume: 0 } });
    });

    it.each([
      [{ sourceUrl: 'u' }, 'name is required'],
      [{ name: 'n' }, 'sourceUrl is required'],
      [
        { name: 'n', sourceUrl: 'u', defaultVolume: -0.1 },
        'defaultVolume must be between 0 and 1',
      ],
      [
        { name: 'n', sourceUrl: 'u', defaultVolume: 1.1 },
        'defaultVolume must be between 0 and 1',
      ],
      [
        { name: 'n', sourceUrl: 'u', defaultVolume: 'abc' },
        'defaultVolume must be between 0 and 1',
      ],
    ])('rejects %j', async (input, message) => {
      const { service } = buildService();
      await expect(
        service.createBackgroundAudio(input, { permissions: ['*'] }),
      ).rejects.toThrow(new BadRequestException(message));
    });
  });

  describe('removeStandaloneAsset', () => {
    it('validates id, existence and permissions', async () => {
      const { service, prisma } = buildService();
      await expect(service.removeStandaloneAsset('', ALL)).rejects.toThrow(
        new BadRequestException('asset id is required'),
      );
      prisma.mediaAsset.findUnique.mockResolvedValueOnce(null);
      await expect(service.removeStandaloneAsset('a', ALL)).rejects.toThrow(
        new NotFoundException('Media asset not found'),
      );
      prisma.mediaAsset.findUnique.mockResolvedValueOnce(standalone());
      await expect(
        service.removeStandaloneAsset('a', { permissions: [] }),
      ).rejects.toThrow(ForbiddenException);
      expect(prisma.mediaAsset.delete).not.toHaveBeenCalled();
    });

    it.each([
      ['image', { image: { id: 1 } }],
      ['audio clip', { audioClip: { id: 1 } }],
      ['song', { song: { id: 1 } }],
      ['song cover', { songCovers: [{ id: 1 }] }],
      ['transition', { transition: { id: 1 } }],
    ])('refuses to delete an asset owned by a %s', async (_name, extra) => {
      const { service, prisma } = buildService();
      prisma.mediaAsset.findUnique.mockResolvedValue(standalone(extra));
      await expect(service.removeStandaloneAsset('a', ALL)).rejects.toThrow(
        new BadRequestException(
          'Use the capability-specific editor to delete this media asset',
        ),
      );
      expect(prisma.mediaAsset.delete).not.toHaveBeenCalled();
    });

    it('deletes a standalone asset', async () => {
      const { service, prisma } = buildService();
      prisma.mediaAsset.findUnique.mockResolvedValue(standalone());
      await expect(
        service.removeStandaloneAsset(' media:abc ', {
          permissions: [P.scene.manage],
        }),
      ).resolves.toEqual({ deletedMediaAssetId: 'media:abc' });
      expect(prisma.mediaAsset.delete).toHaveBeenCalledWith({
        where: { id: 'media:abc' },
      });
    });
  });

  describe('replaceAssetLabels', () => {
    function setup(assetRecord: unknown = asset(), labels = ['l1', 'l2']) {
      const ctx = buildService();
      ctx.prisma.mediaAsset.findUnique.mockResolvedValue(assetRecord);
      ctx.prisma.mediaAsset.findFirst.mockResolvedValue(assetRecord);
      ctx.prisma.mediaLabel.findMany.mockResolvedValue(
        labels.map((id) => ({ id })),
      );
      return ctx;
    }

    it('validates input, asset, permission and labels', async () => {
      const { service, prisma, metrics } = setup();
      await expect(service.replaceAssetLabels('', [], ALL)).rejects.toThrow(
        new BadRequestException('asset id is required'),
      );
      await expect(service.replaceAssetLabels('a', 'x', ALL)).rejects.toThrow(
        new BadRequestException('labelIds must be an array'),
      );
      await expect(
        service.replaceAssetLabels('a', ['ok', 3], ALL),
      ).rejects.toThrow(
        new BadRequestException('labelIds contains an invalid id'),
      );
      await expect(service.replaceAssetLabels('a', [' '], ALL)).rejects.toThrow(
        BadRequestException,
      );

      prisma.mediaAsset.findUnique.mockResolvedValueOnce(null);
      await expect(
        service.replaceAssetLabels('a', ['l1'], ALL),
      ).rejects.toThrow(new NotFoundException('Media asset not found'));

      await expect(
        service.replaceAssetLabels('a', ['l1'], { permissions: [] }),
      ).rejects.toThrow(ForbiddenException);

      await expect(
        service.replaceAssetLabels('a', ['l1', 'l2', 'l3', 'l3'], ALL),
      ).rejects.toThrow(new BadRequestException('Unknown labels: l3'));
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(metrics.recordMediaLabelAssignment).not.toHaveBeenCalled();
    });

    it('rejects legacy labels for non-image assets', async () => {
      const lacksPhysicalImage = setup(asset({ image: null }), [
        'legacy-media-group:4',
      ]);
      await expect(
        lacksPhysicalImage.service.replaceAssetLabels(
          'a',
          ['legacy-media-group:4'],
          ALL,
        ),
      ).rejects.toThrow(
        new BadRequestException(
          'Imported slideshow labels can contain only image assets',
        ),
      );

      const audio = setup(standalone(), ['legacy-media-group:4']);
      await expect(
        audio.service.replaceAssetLabels('a', ['legacy-media-group:4'], ALL),
      ).rejects.toThrow(BadRequestException);
    });

    it('assigns preserved and appended positions and mirrors legacy groups', async () => {
      const { service, prisma, tx, metrics } = setup(asset(), [
        'l1',
        'l2',
        'legacy-media-group:7',
        'legacy-media-group:x',
      ]);
      tx.mediaAssetLabel.findMany
        // current assignments of the asset
        .mockResolvedValueOnce([
          { labelId: 'l1', position: 4 },
          { labelId: 'old', position: 0 },
        ])
        // legacy group 7 mirror
        .mockResolvedValueOnce([
          { asset: { image: { id: 11 } } },
          { asset: { image: null } },
          { asset: { image: { id: 12 } } },
        ]);
      tx.mediaAssetLabel.aggregate
        .mockResolvedValueOnce({ _max: { position: 9 } })
        .mockResolvedValueOnce({ _max: { position: null } })
        .mockResolvedValueOnce({ _max: { position: 0 } });

      await service.replaceAssetLabels(
        'image:1',
        ['l2', 'l1', 'legacy-media-group:7', 'legacy-media-group:x'],
        ALL,
      );

      expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
        maxWait: 30_000,
        timeout: 30_000,
      });
      // locks sorted
      expect(tx.$queryRaw).toHaveBeenCalledTimes(4);
      expect(tx.mediaAssetLabel.deleteMany).toHaveBeenCalledWith({
        where: { assetId: 'image:1' },
      });
      expect(
        tx.mediaAssetLabel.create.mock.calls.map((c) => c[0].data),
      ).toEqual([
        { assetId: 'image:1', labelId: 'l2', position: 10 },
        { assetId: 'image:1', labelId: 'l1', position: 4 },
        { assetId: 'image:1', labelId: 'legacy-media-group:7', position: 0 },
        { assetId: 'image:1', labelId: 'legacy-media-group:x', position: 1 },
      ]);
      expect(tx.mediaGroupItem.deleteMany).toHaveBeenCalledWith({
        where: { mediaGroupId: 7 },
      });
      expect(tx.mediaGroupItem.createMany).toHaveBeenCalledWith({
        data: [
          { mediaGroupId: 7, mediaId: 11, position: 0 },
          { mediaGroupId: 7, mediaId: 12, position: 1 },
        ],
      });
      expect(metrics.recordMediaLabelAssignment).toHaveBeenCalledWith(
        'success',
      );
    });

    it('does not create group items when a mirrored legacy group has no images', async () => {
      const { service, tx } = setup(asset(), ['legacy-media-group:3']);
      tx.mediaAssetLabel.findMany
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);
      await service.replaceAssetLabels('a', ['legacy-media-group:3'], ALL);
      expect(tx.mediaGroupItem.deleteMany).toHaveBeenCalledWith({
        where: { mediaGroupId: 3 },
      });
      expect(tx.mediaGroupItem.createMany).not.toHaveBeenCalled();
    });

    it('allows clearing all labels', async () => {
      const { service, tx } = setup(asset(), []);
      await service.replaceAssetLabels('a', [], ALL);
      expect(tx.mediaAssetLabel.create).not.toHaveBeenCalled();
    });

    it('records failure and rethrows when the transaction fails', async () => {
      const { service, prisma, metrics } = setup();
      const failure = new Error('deadlock');
      prisma.$transaction.mockRejectedValueOnce(failure);
      await expect(service.replaceAssetLabels('a', ['l1'], ALL)).rejects.toBe(
        failure,
      );
      expect(metrics.recordMediaLabelAssignment).toHaveBeenCalledWith(
        'failure',
      );
    });
  });

  describe('labels', () => {
    it('lists labels with and without search', async () => {
      const { service, prisma } = buildService();
      prisma.mediaLabel.findMany.mockResolvedValue([
        labelRecord({
          assets: [{ position: 1, asset: asset() }],
        }),
      ]);
      prisma.mediaLabel.count.mockResolvedValue(11);

      const result = await service.findLabels(
        { search: ' lab ', page: 2, limit: 5 },
        { permissions: [P.media.read] },
      );
      expect(prisma.mediaLabel.findMany).toHaveBeenCalledWith({
        where: { name: { contains: 'lab', mode: 'insensitive' } },
        include: {
          assets: {
            where: { asset: { OR: [{ mediaType: MediaAssetType.IMAGE }] } },
            include: { asset: { include: expect.any(Object) } },
            orderBy: { position: 'asc' },
          },
        },
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
        skip: 5,
        take: 5,
      });
      expect(result.meta).toEqual({
        total: 11,
        page: 2,
        limit: 5,
        totalPages: 3,
      });
      expect(result.data[0]).toMatchObject({
        id: 'l1',
        assetCount: 1,
        assets: [
          { position: 1, asset: expect.objectContaining({ id: 'image:1' }) },
        ],
      });

      await service.findLabels({ page: 1, limit: 5 }, ALL);
      expect(prisma.mediaLabel.findMany.mock.calls[1][0].where).toEqual({});
      await service.findLabels({ search: '  ', page: 1, limit: 5 }, ALL);
      expect(prisma.mediaLabel.findMany.mock.calls[2][0].where).toEqual({});
    });

    it('finds a label or throws', async () => {
      const { service, prisma } = buildService();
      prisma.mediaLabel.findUnique.mockResolvedValueOnce(labelRecord());
      await expect(service.findLabel('l1', ALL)).resolves.toMatchObject({
        id: 'l1',
        assetCount: 0,
        createdAt: ts,
        updatedAt: ts,
      });
      prisma.mediaLabel.findUnique.mockResolvedValueOnce(null);
      await expect(service.findLabel('l1', ALL)).rejects.toThrow(
        new NotFoundException('Media label not found'),
      );
      await expect(service.findLabel(' ', ALL)).rejects.toThrow(
        new BadRequestException('label id is required'),
      );
    });

    it('resolves label images and rejects missing labels', async () => {
      const { service, prisma } = buildService();
      prisma.mediaLabel.findUnique.mockResolvedValueOnce({
        id: 'l1',
        name: 'Label',
        assets: [
          {
            position: 0,
            asset: { id: 'image:1', name: 'A', sourceUrl: 'u' },
          },
        ],
      });
      await expect(service.resolveLabelImages('l1')).resolves.toEqual({
        id: 'l1',
        name: 'Label',
        images: [{ assetId: 'image:1', name: 'A', imageUrl: 'u', position: 0 }],
      });
      prisma.mediaLabel.findUnique.mockResolvedValueOnce(null);
      await expect(service.resolveLabelImages('l1')).rejects.toThrow(
        new NotFoundException('Media label not found'),
      );
      await expect(service.resolveLabelImages('')).rejects.toThrow(
        BadRequestException,
      );
    });

    describe('createLabel', () => {
      it('requires label management', async () => {
        const { service, prisma } = buildService();
        await expect(
          service.createLabel({ name: 'n' }, { permissions: [] }),
        ).rejects.toThrow(ForbiddenException);
        expect(prisma.mediaLabel.create).not.toHaveBeenCalled();
      });

      it.each([
        [undefined, null],
        [null, null],
        ['', null],
        ['   ', null],
        [' desc ', 'desc'],
      ])('normalizes description %p to %p', async (input, expected) => {
        const { service, prisma } = buildService();
        prisma.mediaLabel.create.mockResolvedValue(labelRecord());
        await expect(
          service.createLabel({ name: ' Name ', description: input }, ALL),
        ).resolves.toMatchObject({ id: 'l1' });
        expect(prisma.mediaLabel.create).toHaveBeenCalledWith({
          data: { name: 'Name', description: expected },
          include: expect.any(Object),
        });
      });

      it('rejects bad input', async () => {
        const { service } = buildService();
        await expect(service.createLabel({}, ALL)).rejects.toThrow(
          new BadRequestException('name is required'),
        );
        await expect(
          service.createLabel({ name: 'n', description: 5 }, ALL),
        ).rejects.toThrow(
          new BadRequestException('description must be a string or null'),
        );
      });

      it('maps unique violations and rethrows other errors', async () => {
        const { service, prisma } = buildService();
        prisma.mediaLabel.create.mockRejectedValueOnce(p2002());
        await expect(service.createLabel({ name: 'n' }, ALL)).rejects.toThrow(
          new BadRequestException('Media label name already exists'),
        );
        const other = new Prisma.PrismaClientKnownRequestError('x', {
          code: 'P2003',
          clientVersion: 'test',
        });
        prisma.mediaLabel.create.mockRejectedValueOnce(other);
        await expect(service.createLabel({ name: 'n' }, ALL)).rejects.toBe(
          other,
        );
        const plain = new Error('boom');
        prisma.mediaLabel.create.mockRejectedValueOnce(plain);
        await expect(service.createLabel({ name: 'n' }, ALL)).rejects.toBe(
          plain,
        );
      });
    });

    describe('updateLabel', () => {
      function setup() {
        const ctx = buildService();
        ctx.prisma.mediaLabel.findUnique.mockResolvedValue({ id: 'x' });
        ctx.tx.mediaLabel.findUniqueOrThrow.mockResolvedValue(labelRecord());
        return ctx;
      }

      it('checks permission, id and existence', async () => {
        const { service, prisma } = setup();
        await expect(
          service.updateLabel('l1', {}, { permissions: [] }),
        ).rejects.toThrow(ForbiddenException);
        await expect(service.updateLabel('', {}, ALL)).rejects.toThrow(
          new BadRequestException('label id is required'),
        );
        prisma.mediaLabel.findUnique.mockResolvedValueOnce(null);
        await expect(service.updateLabel('l1', {}, ALL)).rejects.toThrow(
          new NotFoundException('Media label not found'),
        );
      });

      it('skips writes for an empty patch', async () => {
        const { service, tx } = setup();
        await expect(service.updateLabel('l1', {}, ALL)).resolves.toMatchObject(
          {
            id: 'l1',
          },
        );
        await service.updateLabel('legacy-media-group:5', {}, ALL);
        expect(tx.mediaLabel.update).not.toHaveBeenCalled();
        expect(tx.mediaGroup.update).not.toHaveBeenCalled();
      });

      it('updates a regular label name and description without touching groups', async () => {
        const { service, tx } = setup();
        await service.updateLabel(
          'l1',
          { name: ' N ', description: ' d ' },
          ALL,
        );
        expect(tx.mediaLabel.update).toHaveBeenCalledWith({
          where: { id: 'l1' },
          data: { name: 'N', description: 'd' },
        });
        expect(tx.mediaGroup.update).not.toHaveBeenCalled();
      });

      it('mirrors name-only and description-only updates to the legacy group', async () => {
        const { service, tx } = setup();
        await service.updateLabel('legacy-media-group:5', { name: 'N' }, ALL);
        await service.updateLabel(
          'legacy-media-group:5',
          { description: null },
          ALL,
        );
        await service.updateLabel(
          'legacy-media-group:5',
          { description: 'd' },
          ALL,
        );
        await service.updateLabel(
          'legacy-media-group:5',
          { name: 'M', description: '' },
          ALL,
        );
        expect(tx.mediaGroup.update.mock.calls.map((c) => c[0])).toEqual([
          { where: { id: 5 }, data: { name: 'N' } },
          { where: { id: 5 }, data: { description: null } },
          { where: { id: 5 }, data: { description: 'd' } },
          { where: { id: 5 }, data: { name: 'M', description: null } },
        ]);
      });

      it('does not mirror when the legacy id is malformed', async () => {
        const { service, tx } = setup();
        await service.updateLabel('legacy-media-group:0', { name: 'N' }, ALL);
        await service.updateLabel('legacy-media-group:z', { name: 'N' }, ALL);
        expect(tx.mediaLabel.update).toHaveBeenCalledTimes(2);
        expect(tx.mediaGroup.update).not.toHaveBeenCalled();
      });

      it('validates field values', async () => {
        const { service } = setup();
        await expect(
          service.updateLabel('l1', { name: ' ' }, ALL),
        ).rejects.toThrow(new BadRequestException('name is required'));
        await expect(
          service.updateLabel('l1', { description: 3 }, ALL),
        ).rejects.toThrow(BadRequestException);
      });

      it('maps unique violations and rethrows other errors', async () => {
        const { service, prisma } = setup();
        prisma.$transaction.mockRejectedValueOnce(p2002());
        await expect(
          service.updateLabel('l1', { name: 'n' }, ALL),
        ).rejects.toThrow(
          new BadRequestException('Media label name already exists'),
        );
        const plain = new Error('boom');
        prisma.$transaction.mockRejectedValueOnce(plain);
        await expect(
          service.updateLabel('l1', { name: 'n' }, ALL),
        ).rejects.toBe(plain);
      });
    });

    describe('replaceLabelAssets', () => {
      function setup(assets: unknown[] = [asset()], current: string[] = []) {
        const ctx = buildService();
        ctx.prisma.mediaLabel.findUnique.mockResolvedValue({ id: 'l1' });
        ctx.prisma.mediaAssetLabel.findMany.mockResolvedValue(
          current.map((assetId) => ({ assetId })),
        );
        ctx.prisma.mediaAsset.findMany.mockResolvedValue(assets);
        ctx.prisma.mediaLabel.findUnique
          .mockResolvedValueOnce({ id: 'l1' })
          .mockResolvedValue(labelRecord());
        return ctx;
      }

      it('validates input and label existence', async () => {
        const { service, prisma } = setup();
        await expect(service.replaceLabelAssets('', [], ALL)).rejects.toThrow(
          new BadRequestException('label id is required'),
        );
        await expect(service.replaceLabelAssets('l1', {}, ALL)).rejects.toThrow(
          new BadRequestException('assetIds must be an array'),
        );
        prisma.mediaLabel.findUnique.mockReset().mockResolvedValue(null);
        await expect(service.replaceLabelAssets('l1', [], ALL)).rejects.toThrow(
          new NotFoundException('Media label not found'),
        );
      });

      it('rejects unknown assets and unauthorized assets (including currently assigned ones)', async () => {
        const unknown = setup([asset()], []);
        await expect(
          unknown.service.replaceLabelAssets('l1', ['image:1', 'ghost'], ALL),
        ).rejects.toThrow(new BadRequestException('Unknown assets: ghost'));

        const forbidden = setup(
          [asset(), asset({ id: 'image:2' })],
          ['image:2'],
        );
        await expect(
          forbidden.service.replaceLabelAssets('l1', ['image:1'], {
            permissions: [],
          }),
        ).rejects.toThrow(ForbiddenException);
        expect(forbidden.prisma.mediaAsset.findMany).toHaveBeenCalledWith({
          where: { id: { in: ['image:2', 'image:1'] } },
          include: expect.any(Object),
        });
      });

      it('rejects non-image assets for legacy labels', async () => {
        const audio = setup([standalone()]);
        await expect(
          audio.service.replaceLabelAssets(
            'legacy-media-group:2',
            ['media:abc'],
            ALL,
          ),
        ).rejects.toThrow(
          new BadRequestException(
            'Imported slideshow labels can contain only image assets',
          ),
        );

        const noImage = setup([asset({ image: null })]);
        await expect(
          noImage.service.replaceLabelAssets(
            'legacy-media-group:2',
            ['image:1'],
            ALL,
          ),
        ).rejects.toThrow(BadRequestException);
      });

      it('allows non-image assets on regular labels', async () => {
        const { service, tx } = setup([standalone()]);
        await service.replaceLabelAssets('l1', ['media:abc'], ALL);
        expect(tx.mediaAssetLabel.createMany).toHaveBeenCalledWith({
          data: [{ labelId: 'l1', assetId: 'media:abc', position: 0 }],
        });
      });

      it('replaces assignments and mirrors legacy groups', async () => {
        const { service, prisma, tx } = setup(
          [asset(), asset({ id: 'image:2' })],
          ['image:2'],
        );
        tx.mediaAssetLabel.findMany.mockResolvedValueOnce([
          { asset: { image: { id: 1 } } },
          { asset: { image: { id: 2 } } },
        ]);
        prisma.mediaLabel.findUnique.mockReset();
        prisma.mediaLabel.findUnique
          .mockResolvedValueOnce({ id: 'legacy-media-group:6' })
          .mockResolvedValueOnce(labelRecord({ id: 'legacy-media-group:6' }));

        await expect(
          service.replaceLabelAssets(
            'legacy-media-group:6',
            ['image:1', 'image:2', 'image:1'],
            ALL,
          ),
        ).resolves.toMatchObject({ id: 'legacy-media-group:6' });

        expect(tx.mediaAssetLabel.deleteMany).toHaveBeenCalledWith({
          where: { labelId: 'legacy-media-group:6' },
        });
        expect(tx.mediaAssetLabel.createMany).toHaveBeenCalledWith({
          data: [
            {
              labelId: 'legacy-media-group:6',
              assetId: 'image:1',
              position: 0,
            },
            {
              labelId: 'legacy-media-group:6',
              assetId: 'image:2',
              position: 1,
            },
          ],
        });
        expect(tx.mediaGroupItem.createMany).toHaveBeenCalledWith({
          data: [
            { mediaGroupId: 6, mediaId: 1, position: 0 },
            { mediaGroupId: 6, mediaId: 2, position: 1 },
          ],
        });
      });

      it('clears a label when given no assets', async () => {
        const { service, tx } = setup([], []);
        await service.replaceLabelAssets('l1', [], ALL);
        expect(tx.mediaAssetLabel.deleteMany).toHaveBeenCalled();
        expect(tx.mediaAssetLabel.createMany).not.toHaveBeenCalled();
      });
    });

    describe('removeLabel', () => {
      it('checks permission, id and existence', async () => {
        const { service, prisma } = buildService();
        await expect(
          service.removeLabel('l1', { permissions: [] }),
        ).rejects.toThrow(ForbiddenException);
        await expect(service.removeLabel(' ', ALL)).rejects.toThrow(
          new BadRequestException('label id is required'),
        );
        prisma.mediaLabel.findUnique.mockResolvedValueOnce(null);
        await expect(service.removeLabel('l1', ALL)).rejects.toThrow(
          new NotFoundException('Media label not found'),
        );
        expect(prisma.$transaction).not.toHaveBeenCalled();
      });

      it('deletes regular labels directly', async () => {
        const { service, prisma, tx } = buildService();
        prisma.mediaLabel.findUnique.mockResolvedValue({ id: 'l1' });
        await expect(service.removeLabel('l1', ALL)).resolves.toEqual({
          deletedMediaLabelId: 'l1',
        });
        expect(tx.mediaLabel.delete).toHaveBeenCalledWith({
          where: { id: 'l1' },
        });
        expect(tx.mediaGroup.delete).not.toHaveBeenCalled();
      });

      it('deletes the legacy group behind an imported label', async () => {
        const { service, prisma, tx } = buildService();
        prisma.mediaLabel.findUnique.mockResolvedValue({ id: 'x' });
        await service.removeLabel('legacy-media-group:8', ALL);
        expect(tx.mediaGroup.delete).toHaveBeenCalledWith({ where: { id: 8 } });
        expect(tx.mediaLabel.delete).not.toHaveBeenCalled();
      });

      it('falls back to deleting the label when the legacy id is malformed', async () => {
        const { service, prisma, tx } = buildService();
        prisma.mediaLabel.findUnique.mockResolvedValue({ id: 'x' });
        await service.removeLabel('legacy-media-group:nope', ALL);
        expect(tx.mediaLabel.delete).toHaveBeenCalledWith({
          where: { id: 'legacy-media-group:nope' },
        });
      });
    });
  });

  it('records Object paramtypes when dependency imports are unresolved', () => {
    jest.isolateModules(() => {
      jest.doMock('../prisma.service', () => ({}));
      jest.doMock('../observability/managed-metrics.service', () => ({}));
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require('./media-assets.service');
      expect(
        Reflect.getMetadata('design:paramtypes', mod.MediaAssetsService),
      ).toEqual([Object, Object]);
    });
    jest.dontMock('../prisma.service');
    jest.dontMock('../observability/managed-metrics.service');
  });
});
