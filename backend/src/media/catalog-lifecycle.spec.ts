import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { MediaService } from './media.service';
import { SongsService } from '../songs/songs.service';
import { StingersService } from '../stingers/stingers.service';
import { LayoutsService } from '../layouts/layouts.service';

function fixture() {
  let media: any = {
    id: 5,
    name: 'Image',
    imageUrl: 'https://media.example/image.png',
    assetId: 'image:5',
  };
  let song: any = {
    id: 6,
    artist: 'Artist',
    title: 'Title',
    audioUrl: 'https://media.example/song.mp3',
    coverUrl: null,
    enabled: true,
    durationMs: null,
    assetId: 'song:6',
    coverAssetId: null,
    intro: null,
  };
  let stinger: any = {
    id: 7,
    name: 'Wipe',
    videoUrl: 'https://media.example/wipe.webm',
    cutPointMs: 800,
    enabled: true,
    assetId: 'transition:7',
  };
  const prisma: any = {
    media: {
      findMany: jest.fn(async () => [media]),
      count: jest.fn().mockResolvedValue(3),
      findUnique: jest.fn(async () => media),
      create: jest.fn(async ({ data }: any) => {
        media = { id: 5, ...data };
        return media;
      }),
      update: jest.fn(async ({ data }: any) => {
        media = { ...media, ...data };
        return media;
      }),
      findUniqueOrThrow: jest.fn(async () => media),
      delete: jest.fn(),
    },
    song: {
      findMany: jest.fn(async () => [song]),
      count: jest.fn().mockResolvedValue(3),
      aggregate: jest
        .fn()
        .mockResolvedValue({
          _sum: { durationMs: 60000 },
          _count: { durationMs: 2 },
        }),
      findUnique: jest.fn(async () => song),
      create: jest.fn(async ({ data }: any) => {
        song = { id: 6, intro: null, ...data };
        return song;
      }),
      update: jest.fn(async ({ data }: any) => {
        song = { ...song, ...data };
        return song;
      }),
      findUniqueOrThrow: jest.fn(async () => song),
      delete: jest.fn(),
    },
    stinger: {
      findMany: jest.fn(async () => [stinger]),
      findUnique: jest.fn(async () => stinger),
      create: jest.fn(async ({ data }: any) => {
        stinger = { id: 7, ...data };
        return stinger;
      }),
      update: jest.fn(async ({ data }: any) => {
        stinger = { ...stinger, ...data };
        return stinger;
      }),
      findUniqueOrThrow: jest.fn(async () => stinger),
      delete: jest.fn(),
    },
    mediaAsset: { upsert: jest.fn(), deleteMany: jest.fn() },
    mediaGroupItem: {
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn(),
    },
    mediaGroup: {
      findUniqueOrThrow: jest
        .fn()
        .mockResolvedValue({
          id: 9,
          name: 'Remaining group',
          description: null,
          mediaItems: [{ position: 0, media: { assetId: 'image:8' } }],
        }),
    },
    mediaLabel: { upsert: jest.fn() },
    mediaAssetLabel: { deleteMany: jest.fn(), createMany: jest.fn() },
    layout: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn().mockResolvedValue({ id: 2 }),
      create: jest.fn(async ({ data }: any) => ({ id: 2, ...data })),
      update: jest.fn(async ({ data }: any) => ({ id: 2, ...data })),
      delete: jest.fn().mockResolvedValue({ id: 2 }),
    },
  };
  prisma.$transaction = jest.fn(async (callback: (tx: any) => unknown) =>
    callback(prisma),
  );
  return {
    prisma,
    media: () => media,
    song: () => song,
    stinger: () => stinger,
    images: new MediaService(prisma),
    songs: new SongsService(prisma),
    stingers: new StingersService(prisma),
    layouts: new LayoutsService(prisma),
  };
}

describe('legacy catalog API and canonical asset consistency', () => {
  it('queries paginated image search with controlled stable sort fields', async () => {
    const f = fixture();
    expect(
      await f.images.findAll({
        search: ' Image ',
        sortBy: 'name',
        sortOrder: 'asc',
        page: 2,
        limit: 2,
      }),
    ).toEqual({
      data: [f.media()],
      meta: { total: 3, page: 2, limit: 2, totalPages: 2 },
    });
    expect(f.prisma.media.findMany).toHaveBeenCalledWith({
      where: { name: { contains: 'Image', mode: 'insensitive' } },
      orderBy: [{ name: 'asc' }, { id: 'desc' }],
      skip: 2,
      take: 2,
    });
    await f.images.findAll({
      search: ' ',
      sortBy: 'unknown-column',
      sortOrder: 'unsafe',
      page: 1,
      limit: 20,
    });
    expect(f.prisma.media.findMany).toHaveBeenLastCalledWith({
      where: {},
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      skip: 0,
      take: 20,
    });
    await f.images.findAll({ page: 1, limit: 20 });
    expect(f.prisma.media.findMany.mock.calls[2][0].where).toEqual({});
  });

  it('creates and edits images with synchronized canonical identity and avoids an empty edit transaction', async () => {
    const f = fixture();
    expect(
      await f.images.create({
        name: ' New image ',
        imageUrl: ' https://media.example/new.png ',
      }),
    ).toEqual(
      expect.objectContaining({
        id: 5,
        name: 'New image',
        imageUrl: 'https://media.example/new.png',
        assetId: 'image:5',
      }),
    );
    expect(f.prisma.mediaAsset.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'image:5' },
        create: expect.objectContaining({
          kind: 'IMAGE',
          mediaType: 'IMAGE',
          sourceUrl: 'https://media.example/new.png',
        }),
      }),
    );
    await f.images.update(5, {
      name: ' Renamed ',
      imageUrl: ' https://media.example/changed.png ',
    });
    expect(f.media()).toEqual(
      expect.objectContaining({
        name: 'Renamed',
        imageUrl: 'https://media.example/changed.png',
      }),
    );
    const writes = f.prisma.$transaction.mock.calls.length;
    expect(await f.images.update(5, {})).toBe(f.media());
    expect(f.prisma.$transaction).toHaveBeenCalledTimes(writes);
  });

  it.each([
    { name: '', imageUrl: 'url' },
    { name: 1, imageUrl: 'url' },
    { name: 'Image', imageUrl: '' },
  ])('rejects invalid image creation without mutation: %p', async (data) => {
    const f = fixture();
    await expect(f.images.create(data as any)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(f.prisma.$transaction).not.toHaveBeenCalled();
  });

  it('deletes an image once, rebalances each affected group without unique-position collisions and refreshes canonical labels', async () => {
    const f = fixture();
    f.prisma.mediaGroupItem.findMany
      .mockResolvedValueOnce([{ mediaGroupId: 9 }, { mediaGroupId: 9 }])
      .mockResolvedValue([{ id: 21 }, { id: 22 }]);
    expect(await f.images.remove(5)).toEqual({ deletedMediaId: 5 });
    expect(f.prisma.media.delete).toHaveBeenCalledWith({ where: { id: 5 } });
    expect(f.prisma.mediaAsset.deleteMany).toHaveBeenCalledWith({
      where: { id: 'image:5' },
    });
    expect(f.prisma.mediaGroupItem.update.mock.calls).toEqual([
      [{ where: { id: 21 }, data: { position: 100000 } }],
      [{ where: { id: 22 }, data: { position: 100001 } }],
      [{ where: { id: 21 }, data: { position: 0 } }],
      [{ where: { id: 22 }, data: { position: 1 } }],
    ]);
    expect(f.prisma.mediaGroup.findUniqueOrThrow).toHaveBeenCalledTimes(1);
    expect(f.prisma.mediaLabel.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'legacy-media-group:9' } }),
    );
    expect(f.prisma.mediaAssetLabel.createMany).toHaveBeenCalledWith({
      data: [
        { labelId: 'legacy-media-group:9', assetId: 'image:8', position: 0 },
      ],
    });
  });

  it('deletes an ungrouped image without inventing group changes and rejects edits/deletes of missing images', async () => {
    const f = fixture();
    await f.images.remove(5);
    expect(f.prisma.mediaGroupItem.update).not.toHaveBeenCalled();
    f.prisma.media.findUnique.mockResolvedValue(null);
    await expect(f.images.findOne(99)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(
      f.images.update(99, { name: 'Missing' }),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(f.images.remove(99)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('queries a scoped song catalog with truthful aggregate totals and canonical case-insensitive search', async () => {
    const f = fixture();
    f.song().intro = { programId: 'news', instantId: 12 };
    const result = await f.songs.findAll({
      programId: ' news ',
      enabled: false,
      search: ' artist ',
      sortBy: 'durationMs',
      sortOrder: 'asc',
      page: 2,
      limit: 2,
    });
    expect(result.data[0].intro).toEqual({ programId: 'news', instantId: 12 });
    expect(result.meta).toEqual({
      total: 3,
      page: 2,
      limit: 2,
      totalPages: 2,
      catalogTotal: 3,
      catalogEnabled: 3,
      catalogTotalDurationMs: 60000,
      catalogKnownDurationCount: 2,
    });
    expect(f.prisma.song.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          enabled: false,
          OR: [
            { artist: { contains: 'artist', mode: 'insensitive' } },
            { title: { contains: 'artist', mode: 'insensitive' } },
            { earoneSongId: { contains: 'artist', mode: 'insensitive' } },
          ],
        },
        orderBy: [{ durationMs: 'asc' }, { id: 'desc' }],
        skip: 2,
        take: 2,
      }),
    );
    expect((await f.songs.findOne(6, 'other')).intro).toBeNull();
  });

  it('omits empty song search/pagination and defaults invalid sort fields without masking an empty duration total', async () => {
    const f = fixture();
    f.prisma.song.aggregate.mockResolvedValue({
      _sum: { durationMs: null },
      _count: { durationMs: 0 },
    });
    const result = await f.songs.findAll({
      search: ' ',
      sortBy: 'unsafe',
      sortOrder: 'bad',
      page: 1,
      limit: 0,
    });
    expect(result.meta.catalogTotalDurationMs).toBe(0);
    expect(f.prisma.song.findMany.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        where: {},
        orderBy: [{ artist: 'desc' }, { id: 'desc' }],
      }),
    );
    expect(f.prisma.song.findMany.mock.calls[0][0]).not.toHaveProperty('take');
    await f.songs.findAll({ page: 1, limit: 20 });
  });

  it('creates normalized songs and cover assets while retaining explicitly disabled state', async () => {
    const f = fixture();
    const result = await f.songs.create({
      artist: ' Artist ',
      title: ' Title ',
      audioUrl: ' https://media.example/new.mp3 ',
      coverUrl: ' https://media.example/cover.png ',
      durationMs: 1.6,
      earoneSongId: 42,
      earoneRank: ' 2 ',
      earoneSpins: 0,
      enabled: false,
    });
    expect(result).toEqual(
      expect.objectContaining({
        artist: 'Artist',
        title: 'Title',
        audioUrl: 'https://media.example/new.mp3',
        coverUrl: 'https://media.example/cover.png',
        durationMs: 2,
        earoneSongId: '42',
        earoneRank: '2',
        earoneSpins: '0',
        enabled: false,
        assetId: 'song:6',
        coverAssetId: 'song-cover:6',
      }),
    );
    expect(f.prisma.mediaAsset.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'song-cover:6' },
        create: expect.objectContaining({
          mediaType: 'IMAGE',
          sourceUrl: 'https://media.example/cover.png',
        }),
      }),
    );
    const defaults = await f.songs.create({
      title: 'Only title',
      audioUrl: 'https://media.example/default.mp3',
    });
    expect(defaults).toEqual(
      expect.objectContaining({
        artist: '',
        coverUrl: null,
        durationMs: null,
        earoneSongId: null,
        enabled: true,
      }),
    );
  });

  it('updates only provided song fields and removes obsolete canonical cover artwork', async () => {
    const f = fixture();
    f.song().coverAssetId = 'song-cover:6';
    f.song().coverUrl = 'https://media.example/old.png';
    const result = await f.songs.update(6, {
      artist: ' Renamed ',
      title: ' New title ',
      audioUrl: ' https://media.example/updated.mp3 ',
      coverUrl: null,
      durationMs: '1500' as any,
      earoneSongId: '',
      earoneRank: null,
      earoneSpins: Infinity,
      enabled: false,
    });
    expect(result).toEqual(
      expect.objectContaining({
        artist: 'Renamed',
        title: 'New title',
        durationMs: 1500,
        coverUrl: null,
        coverAssetId: null,
        earoneSongId: null,
        earoneRank: null,
        earoneSpins: null,
        enabled: false,
      }),
    );
    expect(f.prisma.mediaAsset.deleteMany).toHaveBeenCalledWith({
      where: { id: 'song-cover:6' },
    });
    await f.songs.update(6, {});
    expect(f.prisma.song.update).toHaveBeenLastCalledWith({
      where: { id: 6 },
      data: { artist: 'Renamed', title: 'New title' },
    });
  });

  it.each([0, -1, NaN, 'not numeric'])(
    'rejects invalid song duration before canonical asset writes: %p',
    async (durationMs) => {
      const f = fixture();
      await expect(
        f.songs.create({
          title: 'Title',
          audioUrl: 'https://media.example/song.mp3',
          durationMs: durationMs as any,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(f.prisma.mediaAsset.upsert).not.toHaveBeenCalled();
    },
  );

  it('requires a song identity and audio URL and preserves the remaining identity field on partial edits', async () => {
    const f = fixture();
    await expect(f.songs.create({ audioUrl: 'url' })).rejects.toThrow(
      'artist or title is required',
    );
    await expect(
      f.songs.create({ title: 'Title', audioUrl: ' ' }),
    ).rejects.toThrow('audioUrl is required');
    await expect(f.songs.update(6, { artist: '', title: '' })).rejects.toThrow(
      'artist or title is required',
    );
    await expect(f.songs.update(6, { audioUrl: '' })).rejects.toThrow(
      'audioUrl is required',
    );
    expect((await f.songs.update(6, { artist: '' })).title).toBe('Title');
  });

  it.each(['create', 'update'] as const)(
    'maps %s uniqueness conflicts and propagates unrelated transaction failures',
    async (method) => {
      const f = fixture();
      const data = {
        artist: 'Artist',
        audioUrl: 'https://media.example/song.mp3',
      };
      const duplicate = new Prisma.PrismaClientKnownRequestError(
        'duplicate intro',
        { code: 'P2002', clientVersion: 'test' },
      );
      f.prisma.$transaction.mockRejectedValueOnce(duplicate);
      const call = () =>
        method === 'create' ? f.songs.create(data) : f.songs.update(6, data);
      await expect(call()).rejects.toThrow(
        'already has an active intro assignment',
      );
      const outage = new Error('database unavailable');
      f.prisma.$transaction.mockRejectedValueOnce(outage);
      await expect(call()).rejects.toBe(outage);
    },
  );

  it('deletes a song and both canonical asset identities together and rejects missing records', async () => {
    const f = fixture();
    expect(await f.songs.remove(6)).toEqual({ deletedSongId: 6 });
    expect(f.prisma.song.delete).toHaveBeenCalledWith({ where: { id: 6 } });
    expect(f.prisma.mediaAsset.deleteMany.mock.calls).toEqual([
      [{ where: { id: 'song:6' } }],
      [{ where: { id: 'song-cover:6' } }],
    ]);
    f.prisma.song.findUnique.mockResolvedValue(null);
    await expect(f.songs.findOne(99)).rejects.toBeInstanceOf(NotFoundException);
    await expect(f.songs.update(99, {})).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(f.songs.remove(99)).rejects.toBeInstanceOf(NotFoundException);
  });

  it.each([1, '', 'x'.repeat(101)])(
    'rejects an unbounded or nontext program scope: %p',
    async (programId) => {
      const f = fixture();
      await expect(f.songs.findOne(6, programId as any)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    },
  );

  it('creates, updates and deletes stingers with canonical transition synchronization', async () => {
    const f = fixture();
    expect((await f.stingers.findAll())[0].id).toBe(7);
    const created = await f.stingers.create({
      name: ' Wipe ',
      videoUrl: ' https://media.example/new.webm ',
    });
    expect(created).toEqual(
      expect.objectContaining({
        name: 'Wipe',
        videoUrl: 'https://media.example/new.webm',
        cutPointMs: 1000,
        enabled: true,
        assetId: 'transition:7',
      }),
    );
    await f.stingers.update(7, {
      name: ' Changed ',
      videoUrl: ' https://media.example/changed.webm ',
      cutPointMs: 500,
      enabled: false,
    });
    expect(f.stinger()).toEqual(
      expect.objectContaining({
        name: 'Changed',
        cutPointMs: 500,
        enabled: false,
      }),
    );
    const transactions = f.prisma.$transaction.mock.calls.length;
    await f.stingers.update(7, {});
    expect(f.prisma.$transaction).toHaveBeenCalledTimes(transactions);
    expect(await f.stingers.remove(7)).toEqual({ deletedStingerId: 7 });
    expect(f.prisma.mediaAsset.deleteMany).toHaveBeenCalledWith({
      where: { id: 'transition:7' },
    });
  });

  it('preserves explicit stinger defaults and rejects invalid names/URLs or missing records', async () => {
    const f = fixture();
    expect(
      await f.stingers.create({
        name: 'Instant cut',
        videoUrl: 'https://media.example/cut.webm',
        cutPointMs: 0,
        enabled: false,
      }),
    ).toEqual(expect.objectContaining({ cutPointMs: 0, enabled: false }));
    await expect(
      f.stingers.create({ name: '', videoUrl: 'url' }),
    ).rejects.toThrow('name is required');
    await expect(f.stingers.create({ name: 'Name' })).rejects.toThrow(
      'videoUrl is required',
    );
    await expect(f.stingers.update(7, { name: ' ' })).rejects.toThrow(
      'name is required',
    );
    await expect(f.stingers.update(7, { videoUrl: ' ' })).rejects.toThrow(
      'videoUrl is required',
    );
    f.prisma.stinger.findUnique.mockResolvedValue(null);
    await expect(f.stingers.findOne(99)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(f.stingers.update(99, {})).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(f.stingers.remove(99)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('serializes reusable layout settings without dropping explicit empty updates', async () => {
    const f = fixture();
    await f.layouts.findAll();
    expect(f.prisma.layout.findMany).toHaveBeenCalledWith({
      orderBy: { name: 'asc' },
    });
    await f.layouts.findOne(2);
    expect(f.prisma.layout.findUnique).toHaveBeenCalledWith({
      where: { id: 2 },
      include: { scenes: true },
    });
    expect(
      await f.layouts.create({
        name: 'Ticker',
        componentType: 'ticker',
        settings: { speed: 2 },
      }),
    ).toEqual({
      id: 2,
      name: 'Ticker',
      componentType: 'ticker',
      settings: '{"speed":2}',
    });
    expect(
      (await f.layouts.create({ name: 'Empty', componentType: 'lower-third' }))
        .settings,
    ).toBe('{}');
    expect(
      await f.layouts.update(2, {
        name: '',
        componentType: 'new',
        settings: {},
      }),
    ).toEqual({ id: 2, name: '', componentType: 'new', settings: '{}' });
    await f.layouts.update(2, {});
    expect(f.prisma.layout.update).toHaveBeenLastCalledWith({
      where: { id: 2 },
      data: {},
    });
    expect(await f.layouts.remove(2)).toEqual({ id: 2 });
  });
});
