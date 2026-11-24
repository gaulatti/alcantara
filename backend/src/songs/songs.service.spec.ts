import { noRecorder } from '../operator-change/operator-change-recorder.testing';
import { BadRequestException } from '@nestjs/common';
import { MediaAssetKind, MediaAssetType } from '@prisma/client';
import { SongsService } from './songs.service';

function buildService() {
  const tx = {
    song: {
      findUnique: jest.fn(),
      findUniqueOrThrow: jest.fn(),
      update: jest
        .fn()
        .mockImplementation(({ data }: { data: Record<string, unknown> }) =>
          Promise.resolve({ ...song, ...data }),
        ),
      create: jest.fn(),
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
    ...tx,
    $transaction: jest.fn((operation: (client: typeof tx) => unknown) =>
      operation(tx),
    ),
  };
  return {
    service: new SongsService(prisma as never, noRecorder()),
    prisma,
    tx,
  };
}

const song = {
  id: 7,
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

describe('SongsService song intros', () => {
  it('assigns and hydrates an authoritative Instant without copying media fields', async () => {
    const { service, tx } = buildService();
    tx.song.findUnique.mockResolvedValue(song);
    tx.programState.findUnique.mockResolvedValue({ programId: 'radio' });
    tx.songIntro.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);
    tx.instant.findUnique.mockResolvedValue({
      id: 12,
      enabled: true,
      audioUrl: 'https://media.test/intro.mp3',
    });
    tx.song.findUniqueOrThrow.mockResolvedValue({
      ...song,
      intro: {
        id: 3,
        songId: song.id,
        instantId: 12,
        programId: 'radio',
        instant: {
          id: 12,
          name: 'Voice segue',
          audioUrl: 'https://media.test/intro.mp3',
          volume: 0.7,
        },
      },
    });

    const result = await service.update(song.id, {
      programId: 'radio',
      introInstantId: 12,
    });

    expect(tx.songIntro.upsert).toHaveBeenCalledWith({
      where: { songId: song.id },
      create: { songId: song.id, instantId: 12, programId: 'radio' },
      update: { instantId: 12 },
    });
    expect(tx.mediaAsset.upsert).toHaveBeenCalledWith({
      where: { id: 'song:7' },
      create: {
        id: 'song:7',
        kind: MediaAssetKind.SONG,
        mediaType: MediaAssetType.AUDIO,
        name: 'Song',
        sourceUrl: 'https://media.test/song.mp3',
        enabled: true,
      },
      update: {
        kind: MediaAssetKind.SONG,
        mediaType: MediaAssetType.AUDIO,
        name: 'Song',
        sourceUrl: 'https://media.test/song.mp3',
        enabled: true,
      },
    });
    expect(result.intro?.instant).toMatchObject({
      audioUrl: 'https://media.test/intro.mp3',
      volume: 0.7,
    });
  });

  it('removes an existing intro only from its owning program', async () => {
    const { service, tx } = buildService();
    tx.song.findUnique.mockResolvedValue(song);
    tx.programState.findUnique.mockResolvedValue({ programId: 'radio' });
    tx.songIntro.findUnique.mockResolvedValue({
      id: 3,
      programId: 'radio',
      instantId: 12,
    });
    tx.song.findUniqueOrThrow.mockResolvedValue({ ...song, intro: null });

    await service.update(song.id, {
      programId: 'radio',
      introInstantId: null,
    });

    expect(tx.songIntro.delete).toHaveBeenCalledWith({ where: { id: 3 } });
  });

  it('rejects cross-program replacement and already-assigned Instants', async () => {
    const crossProgram = buildService();
    crossProgram.tx.song.findUnique.mockResolvedValue(song);
    crossProgram.tx.programState.findUnique.mockResolvedValue({
      programId: 'television',
    });
    crossProgram.tx.songIntro.findUnique.mockResolvedValue({
      id: 3,
      programId: 'radio',
      instantId: 12,
    });
    await expect(
      crossProgram.service.update(song.id, {
        programId: 'television',
        introInstantId: 13,
      }),
    ).rejects.toThrow('Song intro belongs to another program');

    const assigned = buildService();
    assigned.tx.song.findUnique.mockResolvedValue(song);
    assigned.tx.programState.findUnique.mockResolvedValue({
      programId: 'radio',
    });
    assigned.tx.songIntro.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ songId: 99, programId: 'radio' });
    assigned.tx.instant.findUnique.mockResolvedValue({
      id: 13,
      enabled: true,
      audioUrl: 'https://media.test/other.mp3',
    });
    await expect(
      assigned.service.update(song.id, {
        programId: 'radio',
        introInstantId: 13,
      }),
    ).rejects.toThrow('Instant is already assigned as a song intro');
  });

  it('rejects missing, disabled, and malformed intro identities', async () => {
    for (const [name, instantId, instant] of [
      ['malformed', -1, null],
      ['missing', 12, null],
      ['disabled', 12, { id: 12, enabled: false, audioUrl: 'url' }],
    ] as const) {
      const { service, tx } = buildService();
      tx.song.findUnique.mockResolvedValue(song);
      tx.programState.findUnique.mockResolvedValue({ programId: 'radio' });
      tx.songIntro.findUnique.mockResolvedValue(null);
      tx.instant.findUnique.mockResolvedValue(instant);
      await expect(
        service.update(song.id, {
          programId: 'radio',
          introInstantId: instantId,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(tx.songIntro.upsert).not.toHaveBeenCalled();
      expect(name).toBeTruthy();
    }
  });
});

describe('SongsService re-analysis request (gaulatti/alcantara#235)', () => {
  const NOW = new Date('2026-11-24T10:00:00.000Z');
  const build = (analysed: string[]) => {
    const prisma = {
      mediaAssetAnalysis: {
        findMany: jest.fn(async () => analysed.map((assetId) => ({ assetId }))),
        updateMany: jest.fn(async ({ where }: any) => ({
          count: where.assetId.in.length,
        })),
      },
    };
    return { service: new SongsService(prisma as never), prisma };
  };

  it('makes the finished analyses of the named songs due now, keeping their cues, and lists the songs it skipped', async () => {
    const { service, prisma } = build(['song:1', 'song:3']);
    await expect(service.requestReanalysis([1, 2, 3], NOW)).resolves.toEqual({
      requested: 2,
      skipped: [2],
    });
    expect(prisma.mediaAssetAnalysis.findMany).toHaveBeenCalledWith({
      where: {
        assetId: { in: ['song:1', 'song:2', 'song:3'] },
        status: 'success',
      },
      select: { assetId: true },
    });
    expect(prisma.mediaAssetAnalysis.updateMany).toHaveBeenCalledWith({
      where: { assetId: { in: ['song:1', 'song:3'] }, status: 'success' },
      data: { nextAttemptAt: NOW },
    });
  });

  it('queues nothing when no named song has a finished analysis', async () => {
    const { service } = build([]);
    await expect(service.requestReanalysis([5])).resolves.toEqual({
      requested: 0,
      skipped: [5],
    });
  });

  it('accepts exactly 25 songs and refuses 26, none, duplicates and anything that is not a song id', async () => {
    const { service, prisma } = build([]);
    const ids = Array.from({ length: 25 }, (_, index) => index + 1);
    await expect(service.requestReanalysis(ids)).resolves.toMatchObject({
      requested: 0,
    });
    for (const bad of [
      [...ids, 26],
      [],
      [1, 1],
      [0],
      [-3],
      [1.5],
      ['7'],
      '7',
      undefined,
      null,
    ]) {
      await expect(service.requestReanalysis(bad)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    }
    expect(prisma.mediaAssetAnalysis.findMany).toHaveBeenCalledTimes(1);
  });
});
