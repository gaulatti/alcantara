/* eslint-disable @typescript-eslint/no-unsafe-assignment -- Jest mocks are intentionally loosely typed. */
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { SongsService } from './songs.service';

const base = {
  id: 7,
  assetId: 'song:7',
  coverAssetId: null,
  artist: 'Artist',
  title: 'Song',
  audioUrl: 'https://media.test/song.mp3',
  coverUrl: null,
  durationMs: 120000,
  earoneSongId: null,
  earoneRank: null,
  earoneSpins: null,
  enabled: true,
};

function build() {
  const tx = {
    song: {
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      findUniqueOrThrow: jest.fn(),
    },
    programState: { findUnique: jest.fn() },
    instant: { findUnique: jest.fn() },
    songIntro: {
      findUnique: jest.fn(),
      upsert: jest.fn(),
      delete: jest.fn(),
    },
    mediaAsset: { upsert: jest.fn(), deleteMany: jest.fn() },
  };
  const prisma = {
    song: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      count: jest.fn(),
      aggregate: jest.fn(),
    },
    $transaction: jest.fn((op: (client: typeof tx) => unknown) => op(tx)),
  };
  return { service: new SongsService(prisma as never), prisma, tx };
}

function p2002() {
  return new Prisma.PrismaClientKnownRequestError('dup', {
    code: 'P2002',
    clientVersion: 'test',
  });
}

describe('SongsService.findAll', () => {
  function setup(sum: number | null = 300) {
    const ctx = build();
    ctx.prisma.song.findMany.mockResolvedValue([
      { ...base, intro: { programId: 'main', id: 1 } },
      { ...base, id: 8, intro: { programId: 'radio', id: 2 } },
      { ...base, id: 9, intro: null },
    ]);
    ctx.prisma.song.count
      .mockResolvedValueOnce(20)
      .mockResolvedValueOnce(30)
      .mockResolvedValueOnce(25);
    ctx.prisma.song.aggregate.mockResolvedValue({
      _sum: { durationMs: sum },
      _count: { durationMs: 4 },
    });
    return ctx;
  }

  it('applies filters, sorting, pagination and scopes intros to the program', async () => {
    const { service, prisma } = setup();
    const result = await service.findAll({
      search: '  rock ',
      enabled: false,
      sortBy: 'title',
      sortOrder: 'asc',
      page: 3,
      limit: 5,
    });

    const where = {
      enabled: false,
      OR: [
        { artist: { contains: 'rock', mode: 'insensitive' } },
        { title: { contains: 'rock', mode: 'insensitive' } },
        { earoneSongId: { contains: 'rock', mode: 'insensitive' } },
      ],
    };
    expect(prisma.song.findMany).toHaveBeenCalledWith({
      where,
      orderBy: [{ title: 'asc' }, { id: 'desc' }],
      include: { intro: { include: { instant: true } } },
      skip: 10,
      take: 5,
    });
    expect(prisma.song.count).toHaveBeenNthCalledWith(1, { where });
    expect(prisma.song.count).toHaveBeenNthCalledWith(2);
    expect(prisma.song.count).toHaveBeenNthCalledWith(3, {
      where: { enabled: true },
    });
    expect(result.data.map((s) => s.intro)).toEqual([
      { programId: 'main', id: 1 },
      null,
      null,
    ]);
    expect(result.meta).toEqual({
      total: 20,
      page: 3,
      limit: 5,
      totalPages: 4,
      catalogTotal: 30,
      catalogEnabled: 25,
      catalogTotalDurationMs: 300,
      catalogKnownDurationCount: 4,
    });
  });

  it('uses default sorting, no filters, a requested program and unlimited paging', async () => {
    const { service, prisma } = setup(null);
    const result = await service.findAll({
      sortBy: 'bogus',
      sortOrder: 'sideways',
      page: 1,
      limit: 0,
      programId: ' radio ',
    });
    expect(prisma.song.findMany).toHaveBeenCalledWith({
      where: {},
      orderBy: [{ artist: 'desc' }, { id: 'desc' }],
      include: { intro: { include: { instant: true } } },
    });
    expect(result.data[1].intro).toEqual({ programId: 'radio', id: 2 });
    expect(result.data[0].intro).toBeNull();
    expect(result.meta.catalogTotalDurationMs).toBe(0);
  });

  it('ignores blank searches and rejects an invalid programId', async () => {
    const { service, prisma } = setup();
    await service.findAll({ search: '   ', page: 1, limit: 10 });
    expect(prisma.song.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: {} }),
    );
    await expect(
      service.findAll({ page: 1, limit: 10, programId: '   ' }),
    ).rejects.toThrow('programId must be a non-empty bounded string');
    await expect(
      service.findAll({ page: 1, limit: 10, programId: 'x'.repeat(101) }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('SongsService.findOne', () => {
  it('returns a song with the main-program intro by default', async () => {
    const { service, prisma } = build();
    prisma.song.findUnique.mockResolvedValue({
      ...base,
      intro: { programId: 'main' },
    });
    await expect(service.findOne(7)).resolves.toEqual({
      ...base,
      intro: { programId: 'main' },
    });
    expect(prisma.song.findUnique).toHaveBeenCalledWith({
      where: { id: 7 },
      include: { intro: { include: { instant: true } } },
    });
  });

  it('hides intros of other programs and throws for unknown songs', async () => {
    const { service, prisma } = build();
    prisma.song.findUnique.mockResolvedValueOnce({
      ...base,
      intro: { programId: 'radio' },
    });
    await expect(service.findOne(7, 'main')).resolves.toMatchObject({
      intro: null,
    });
    prisma.song.findUnique.mockResolvedValueOnce(null);
    await expect(service.findOne(1)).rejects.toThrow(
      new NotFoundException('Song not found'),
    );
  });
});

describe('SongsService.create', () => {
  it('normalizes every field and skips the intro when not requested', async () => {
    const { service, tx } = build();
    tx.song.create.mockResolvedValue(base);
    tx.song.findUniqueOrThrow.mockResolvedValue({ ...base, intro: null });
    await expect(
      service.create({
        artist: ' A ',
        title: ' T ',
        audioUrl: ' https://a/b.mp3 ',
        coverUrl: ' https://a/c.png ',
        durationMs: '1500.4' as never,
        earoneSongId: 12,
        earoneRank: ' 3 ',
        earoneSpins: Number.NaN,
        enabled: false,
      }),
    ).resolves.toMatchObject({ id: 7, intro: null });
    expect(tx.song.create).toHaveBeenCalledWith({
      data: {
        artist: 'A',
        title: 'T',
        audioUrl: 'https://a/b.mp3',
        coverUrl: 'https://a/c.png',
        durationMs: 1500,
        earoneSongId: '12',
        earoneRank: '3',
        earoneSpins: null,
        enabled: false,
      },
    });
    expect(tx.mediaAsset.upsert).toHaveBeenCalled();
    expect(tx.programState.findUnique).not.toHaveBeenCalled();
  });

  it('defaults enabled to true and optional values to null', async () => {
    const { service, tx } = build();
    tx.song.create.mockResolvedValue(base);
    tx.song.findUniqueOrThrow.mockResolvedValue({ ...base, intro: null });
    await service.create({
      title: 'Only title',
      audioUrl: 'u',
      coverUrl: '  ',
      durationMs: '' as never,
      earoneSongId: '   ',
      earoneRank: null,
    });
    expect(tx.song.create).toHaveBeenCalledWith({
      data: {
        artist: '',
        title: 'Only title',
        audioUrl: 'u',
        coverUrl: null,
        durationMs: null,
        earoneSongId: null,
        earoneRank: null,
        earoneSpins: null,
        enabled: true,
      },
    });
  });

  it('creates with an intro in the requested program', async () => {
    const { service, tx } = build();
    tx.song.create.mockResolvedValue(base);
    tx.programState.findUnique.mockResolvedValue({ programId: 'radio' });
    tx.songIntro.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);
    tx.instant.findUnique.mockResolvedValue({
      id: 2,
      enabled: true,
      audioUrl: 'u',
    });
    tx.song.findUniqueOrThrow.mockResolvedValue({
      ...base,
      intro: { programId: 'radio', instantId: 2 },
    });
    const result = await service.create({
      artist: 'A',
      audioUrl: 'u',
      programId: 'radio',
      introInstantId: 2,
    });
    expect(tx.songIntro.upsert).toHaveBeenCalledWith({
      where: { songId: 7 },
      create: { songId: 7, instantId: 2, programId: 'radio' },
      update: { instantId: 2 },
    });
    expect(result.intro).toEqual({ programId: 'radio', instantId: 2 });
  });

  it('validates required fields', async () => {
    const { service, prisma } = build();
    await expect(service.create({ audioUrl: 'u' })).rejects.toThrow(
      'artist or title is required',
    );
    await expect(service.create({ artist: 'A' })).rejects.toThrow(
      'audioUrl is required',
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('rejects non-positive and non-numeric durations', async () => {
    const { service } = build();
    await expect(
      service.create({ artist: 'A', audioUrl: 'u', durationMs: -1 }),
    ).rejects.toThrow('durationMs must be a positive number');
    await expect(
      service.create({
        artist: 'A',
        audioUrl: 'u',
        durationMs: 'abc' as never,
      }),
    ).rejects.toThrow('durationMs must be a positive number');
  });

  it('rounds tiny durations up to one millisecond', async () => {
    const { service, tx } = build();
    tx.song.create.mockResolvedValue(base);
    tx.song.findUniqueOrThrow.mockResolvedValue({ ...base, intro: null });
    await service.create({ artist: 'A', audioUrl: 'u', durationMs: 0.2 });
    expect(tx.song.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ durationMs: 1 }),
    });
  });

  it('translates unique-constraint conflicts and rethrows other errors', async () => {
    const { service, tx } = build();
    tx.song.create.mockRejectedValueOnce(p2002());
    await expect(
      service.create({ artist: 'A', audioUrl: 'u' }),
    ).rejects.toThrow('Song or Instant already has an active intro assignment');
    const boom = new Error('boom');
    tx.song.create.mockRejectedValueOnce(boom);
    await expect(service.create({ artist: 'A', audioUrl: 'u' })).rejects.toBe(
      boom,
    );
    tx.song.create.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('other', {
        code: 'P2025',
        clientVersion: 'test',
      }),
    );
    await expect(
      service.create({ artist: 'A', audioUrl: 'u' }),
    ).rejects.toMatchObject({ code: 'P2025' });
  });
});

describe('SongsService.update', () => {
  it('keeps existing artist and title and updates only provided fields', async () => {
    const { service, prisma, tx } = build();
    prisma.song.findUnique.mockResolvedValue(base);
    tx.song.update.mockResolvedValue(base);
    tx.song.findUniqueOrThrow.mockResolvedValue({ ...base, intro: null });
    await service.update(7, { enabled: false });
    expect(tx.song.update).toHaveBeenCalledWith({
      where: { id: 7 },
      data: { artist: 'Artist', title: 'Song', enabled: false },
    });
    expect(tx.programState.findUnique).not.toHaveBeenCalled();
  });

  it('normalizes every updatable field', async () => {
    const { service, prisma, tx } = build();
    prisma.song.findUnique.mockResolvedValue(base);
    tx.song.update.mockResolvedValue(base);
    tx.song.findUniqueOrThrow.mockResolvedValue({ ...base, intro: null });
    await service.update(7, {
      artist: ' X ',
      title: ' Y ',
      audioUrl: ' u2 ',
      coverUrl: null,
      durationMs: 2000,
      earoneSongId: 5,
      earoneRank: '2',
      earoneSpins: null,
      enabled: true,
    });
    expect(tx.song.update).toHaveBeenCalledWith({
      where: { id: 7 },
      data: {
        artist: 'X',
        title: 'Y',
        audioUrl: 'u2',
        coverUrl: null,
        durationMs: 2000,
        earoneSongId: '5',
        earoneRank: '2',
        earoneSpins: null,
        enabled: true,
      },
    });
  });

  it('rejects unknown songs, emptied names and blank audio', async () => {
    const { service, prisma } = build();
    prisma.song.findUnique.mockResolvedValueOnce(null);
    await expect(service.update(1, {})).rejects.toThrow(
      new NotFoundException('Song not found'),
    );
    prisma.song.findUnique.mockResolvedValue(base);
    await expect(service.update(7, { artist: '', title: '' })).rejects.toThrow(
      'artist or title is required',
    );
    await expect(service.update(7, { audioUrl: ' ' })).rejects.toThrow(
      'audioUrl is required',
    );
  });

  it('clears the intro of a song when introInstantId is null', async () => {
    const { service, prisma, tx } = build();
    prisma.song.findUnique.mockResolvedValue(base);
    tx.song.update.mockResolvedValue(base);
    tx.programState.findUnique.mockResolvedValue({ programId: 'main' });
    tx.songIntro.findUnique.mockResolvedValue(null);
    tx.song.findUniqueOrThrow.mockResolvedValue({ ...base, intro: null });
    await service.update(7, { introInstantId: null });
    expect(tx.songIntro.delete).not.toHaveBeenCalled();
    expect(tx.songIntro.upsert).not.toHaveBeenCalled();
  });

  it('reports a missing program', async () => {
    const { service, prisma, tx } = build();
    prisma.song.findUnique.mockResolvedValue(base);
    tx.song.update.mockResolvedValue(base);
    tx.programState.findUnique.mockResolvedValue(null);
    await expect(
      service.update(7, { introInstantId: 3, programId: 'ghost' }),
    ).rejects.toThrow(new BadRequestException('Program not found'));
  });

  it('rejects non-integer intro ids and instants without playable audio', async () => {
    const { service, prisma, tx } = build();
    prisma.song.findUnique.mockResolvedValue(base);
    tx.song.update.mockResolvedValue(base);
    tx.programState.findUnique.mockResolvedValue({ programId: 'main' });
    tx.songIntro.findUnique.mockResolvedValue(null);
    await expect(service.update(7, { introInstantId: 1.5 })).rejects.toThrow(
      'introInstantId must identify an Instant',
    );
    tx.instant.findUnique.mockResolvedValue({
      id: 3,
      enabled: true,
      audioUrl: '   ',
    });
    await expect(service.update(7, { introInstantId: 3 })).rejects.toThrow(
      'Song intro Instant is missing or unavailable',
    );
  });

  it('allows re-assigning an Instant already owned by the same song', async () => {
    const { service, prisma, tx } = build();
    prisma.song.findUnique.mockResolvedValue(base);
    tx.song.update.mockResolvedValue(base);
    tx.programState.findUnique.mockResolvedValue({ programId: 'main' });
    tx.instant.findUnique.mockResolvedValue({
      id: 3,
      enabled: true,
      audioUrl: 'u',
    });
    tx.songIntro.findUnique
      .mockResolvedValueOnce({ id: 1, programId: 'main', instantId: 3 })
      .mockResolvedValueOnce({ songId: 7, programId: 'main' });
    tx.song.findUniqueOrThrow.mockResolvedValue({ ...base, intro: null });
    await service.update(7, { introInstantId: 3 });
    expect(tx.songIntro.upsert).toHaveBeenCalledWith({
      where: { songId: 7 },
      create: { songId: 7, instantId: 3, programId: 'main' },
      update: { instantId: 3 },
    });
  });

  it('translates unique conflicts during update', async () => {
    const { service, prisma, tx } = build();
    prisma.song.findUnique.mockResolvedValue(base);
    tx.song.update.mockRejectedValue(p2002());
    await expect(service.update(7, { enabled: true })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});

describe('SongsService.remove', () => {
  it('deletes the song and its media assets', async () => {
    const { service, prisma, tx } = build();
    prisma.song.findUnique.mockResolvedValue(base);
    await expect(service.remove(7)).resolves.toEqual({ deletedSongId: 7 });
    expect(tx.song.delete).toHaveBeenCalledWith({ where: { id: 7 } });
    expect(tx.mediaAsset.deleteMany).toHaveBeenNthCalledWith(1, {
      where: { id: 'song:7' },
    });
    expect(tx.mediaAsset.deleteMany).toHaveBeenNthCalledWith(2, {
      where: { id: 'song-cover:7' },
    });
  });

  it('throws NotFoundException for an unknown song', async () => {
    const { service, prisma } = build();
    prisma.song.findUnique.mockResolvedValue(null);
    await expect(service.remove(7)).rejects.toThrow('Song not found');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
