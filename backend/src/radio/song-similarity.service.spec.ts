import { BadRequestException, Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaService } from '../prisma.service';
import { RadioMetricsService } from './radio-metrics.service';
import { SongSimilarityService } from './song-similarity.service';
import { SIMILARITY_EVALUATION_PAIRS } from './song-similarity.fixtures';
import { SIMILARITY_MODEL } from './song-similarity.utils';
import type { ProgramResolvedSongLeaf } from './song-sequence.utils';

const DIM = 1280;
const unit = (index: number): number[] => {
  const v = new Array<number>(DIM).fill(0);
  v[index] = 1;
  return v;
};
const literal = (v: number[]) => `[${v.join(',')}]`;
const sha = 'a'.repeat(64);

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

const leaf = (
  id: string,
  songId: number | undefined,
  artist: string,
  audioUrl = `https://cdn/${id}.mp3`,
): ProgramResolvedSongLeaf => ({
  id,
  songId,
  highRotation: false,
  artist,
  title: id,
  coverUrl: '',
  audioUrl,
  activePathLabels: [],
});

function setup() {
  const prisma = {
    radioSettings: { findMany: jest.fn(), findFirst: jest.fn() },
    programState: { update: jest.fn(), findUnique: jest.fn() },
    song: { findMany: jest.fn(), count: jest.fn() },
    similarityDecision: {
      create: jest.fn(),
      findFirst: jest.fn(),
      deleteMany: jest.fn(),
      findMany: jest.fn(),
    },
    $queryRaw: jest.fn(),
    $executeRaw: jest.fn(),
    $transaction: jest.fn(),
  };
  prisma.programState.update.mockResolvedValue({});
  prisma.similarityDecision.create.mockResolvedValue({});
  prisma.$transaction.mockResolvedValue([]);
  const metrics = { recordSimilarityAction: jest.fn() };
  const service = new SongSimilarityService(prisma as never, metrics as never);
  return { prisma, metrics, service };
}

const settingsRow = (
  programId: string,
  mode: string,
  extra: Record<string, unknown> = {},
) => ({
  similarityMode: mode,
  similarityThreshold: 0.5,
  similarityWindowSeconds: 30,
  similarityPool: 'sequence',
  programState: { programId, songArtistCycle: { artists: [] } },
  ...extra,
});

/** Loads one active station with embeddings for songs 1 (A), 2 (B), 3 (C). */
async function activeService(pool = 'sequence') {
  const ctx = setup();
  ctx.prisma.radioSettings.findMany.mockResolvedValue([
    settingsRow('radio', 'on', { similarityPool: pool }),
  ]);
  ctx.prisma.$queryRaw.mockResolvedValue([
    {
      songId: 1,
      segment: 'closing',
      windowSeconds: 30,
      vector: literal(unit(0)),
    },
    {
      songId: 2,
      segment: 'opening',
      windowSeconds: 30,
      vector: literal(unit(0)),
    },
    {
      songId: 3,
      segment: 'opening',
      windowSeconds: 30,
      vector: literal(unit(1)),
    },
  ]);
  ctx.prisma.song.findMany.mockResolvedValue([
    {
      id: 2,
      artist: 'B',
      title: 'Two',
      audioUrl: 'https://cdn/2.mp3',
      coverUrl: null,
      durationMs: null,
    },
    {
      id: 3,
      artist: 'C',
      title: 'Three',
      audioUrl: 'https://cdn/3.mp3',
      coverUrl: 'https://cdn/3.jpg',
      durationMs: 1000,
    },
  ]);
  await ctx.service.onSettingsChanged();
  return ctx;
}

describe('SongSimilarityService', () => {
  let errorSpy: jest.SpyInstance;
  beforeEach(() => {
    errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation();
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  describe('lifecycle and settings', () => {
    it('resolves its dependencies through the Nest container', async () => {
      const moduleRef = await Test.createTestingModule({
        providers: [
          SongSimilarityService,
          { provide: PrismaService, useValue: {} },
          { provide: RadioMetricsService, useValue: {} },
        ],
      }).compile();
      expect(moduleRef.get(SongSimilarityService)).toBeInstanceOf(
        SongSimilarityService,
      );
    });

    it('defaults to off for unknown stations', () => {
      const { service } = setup();
      expect(service.getSettings('nope').mode).toBe('off');
    });

    it('stays off and skips embeddings when every station is off', async () => {
      const { prisma, service } = setup();
      prisma.radioSettings.findMany.mockResolvedValue([
        settingsRow('radio', 'off'),
      ]);
      await service.onModuleInit();
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
      service.onModuleDestroy();
    });

    it('loads embeddings on init when a station is active', async () => {
      const { prisma, service } = setup();
      prisma.radioSettings.findMany.mockResolvedValue([
        settingsRow('radio', 'shadow'),
      ]);
      prisma.$queryRaw.mockResolvedValue([]);
      prisma.song.findMany.mockResolvedValue([]);
      await service.onModuleInit();
      expect(service.getSettings('radio').mode).toBe('shadow');
      expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
      service.onModuleDestroy();
    });

    it('keeps similarity off when the settings load fails', async () => {
      const { prisma, service } = setup();
      prisma.radioSettings.findMany.mockRejectedValue(new Error('db down'));
      await service.onModuleInit();
      expect(service.getSettings('radio').mode).toBe('off');
      expect(errorSpy).toHaveBeenCalled();
      service.onModuleDestroy();
    });

    it('refreshes embeddings on the timer only while a station is active', async () => {
      jest.useFakeTimers();
      const { prisma, service } = setup();
      prisma.radioSettings.findMany.mockResolvedValue([
        settingsRow('radio', 'off'),
      ]);
      await service.onModuleInit();
      await jest.advanceTimersByTimeAsync(5 * 60 * 1000);
      expect(prisma.$queryRaw).not.toHaveBeenCalled();

      prisma.radioSettings.findMany.mockResolvedValue([
        settingsRow('radio', 'on'),
      ]);
      prisma.$queryRaw.mockResolvedValue([]);
      prisma.song.findMany.mockResolvedValue([]);
      await service.reloadSettings();
      await jest.advanceTimersByTimeAsync(5 * 60 * 1000);
      expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);

      prisma.$queryRaw.mockRejectedValue(new Error('refresh failed'));
      await jest.advanceTimersByTimeAsync(5 * 60 * 1000);
      expect(errorSpy).toHaveBeenCalled();
      service.onModuleDestroy();
    });

    it('destroys cleanly without a timer', () => {
      const { service } = setup();
      expect(() => service.onModuleDestroy()).not.toThrow();
    });

    it('does not reload embeddings after a change to off', async () => {
      const { prisma, service } = setup();
      prisma.radioSettings.findMany.mockResolvedValue([
        settingsRow('radio', 'off'),
      ]);
      await service.onSettingsChanged();
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
    });
  });

  describe('propose', () => {
    it('picks the best-matching sequence leaf', async () => {
      const { service } = await activeService();
      const proposal = service.propose('radio', {
        currentSongId: 1,
        currentArtist: 'A',
        leaves: [
          { leaf: leaf('i2', 2, 'B'), blocked: false },
          { leaf: leaf('i3', 3, 'C'), blocked: false },
          { leaf: leaf('skip-no-song', undefined, 'D'), blocked: false },
          { leaf: leaf('skip-no-url', 9, 'E', ''), blocked: false },
        ],
      });
      expect(proposal.result.outcome).toBe('selected');
      expect(proposal.leaf?.id).toBe('i2');
    });

    it('falls back without a closing embedding', async () => {
      const { service } = await activeService();
      const proposal = service.propose('radio', {
        currentSongId: null,
        currentArtist: '',
        leaves: [{ leaf: leaf('i2', 2, 'B'), blocked: false }],
      });
      expect(proposal.result.outcome).toBe('fallback-no-embedding');
      expect(proposal.leaf).toBeNull();
    });

    it('does not consult the catalog with the sequence pool', async () => {
      const { service } = await activeService('sequence');
      const proposal = service.propose('radio', {
        currentSongId: 1,
        currentArtist: 'A',
        leaves: [{ leaf: leaf('i3', 3, 'C'), blocked: false }],
      });
      expect(proposal.result.outcome).toBe('fallback-no-candidate');
      expect(proposal.leaf).toBeNull();
    });

    it('fills from the catalog when the sequence has no candidate', async () => {
      const { service } = await activeService('catalog');
      const proposal = service.propose('radio', {
        currentSongId: 1,
        currentArtist: 'A',
        leaves: [{ leaf: leaf('i3', 3, 'C'), blocked: false }],
      });
      expect(proposal.result.outcome).toBe('selected');
      expect(proposal.leaf?.id).toBe('catalog:2');
      expect(proposal.leaf?.coverUrl).toBe('');
      expect(proposal.leaf?.durationMs).toBeUndefined();
    });

    it('keeps the fallback when the catalog has no candidate either', async () => {
      const { service } = await activeService('catalog');
      const proposal = service.propose('radio', {
        currentSongId: 1,
        currentArtist: 'A',
        leaves: [
          { leaf: leaf('i2', 2, 'B'), blocked: true },
          { leaf: leaf('i3', 3, 'C'), blocked: false },
        ],
      });
      // Song 2 is in the sequence (blocked) so the catalog skips it; song 3
      // is in the sequence too, leaving the catalog empty.
      expect(proposal.result.outcome).toBe('fallback-no-candidate');
      expect(proposal.leaf).toBeNull();
    });

    it('uses an empty cycle for a station without one', () => {
      const { service } = setup();
      const proposal = service.propose('unknown', {
        currentSongId: 1,
        currentArtist: 'A',
        leaves: [],
      });
      expect(proposal.result.outcome).toBe('fallback-no-embedding');
    });
  });

  describe('noteSongStarted', () => {
    it('does nothing while off', () => {
      const { prisma, service } = setup();
      service.noteSongStarted('radio', 'A');
      expect(prisma.programState.update).not.toHaveBeenCalled();
    });

    it('persists a new artist and ignores a repeat', async () => {
      const { prisma, service } = await activeService();
      service.noteSongStarted('radio', 'A');
      service.noteSongStarted('radio', 'A');
      service.noteSongStarted('radio', '');
      expect(prisma.programState.update).toHaveBeenCalledTimes(1);
      expect(prisma.programState.update).toHaveBeenCalledWith({
        where: { programId: 'radio' },
        data: { songArtistCycle: { artists: ['a'] } },
      });
    });

    it('starts a new cycle on reset', async () => {
      const { prisma, service } = await activeService();
      service.noteSongStarted('radio', 'A');
      service.noteSongStarted('radio', 'B', { resetCycle: true });
      expect(prisma.programState.update).toHaveBeenLastCalledWith({
        where: { programId: 'radio' },
        data: { songArtistCycle: { artists: ['b'] } },
      });
    });

    it('tracks artists for a station without a loaded cycle', () => {
      const { prisma, service } = setup();
      (service as unknown as { settings: Map<string, unknown> }).settings.set(
        'fresh',
        { mode: 'shadow', threshold: 0.8, windowSeconds: 30, pool: 'sequence' },
      );
      service.noteSongStarted('fresh', 'Z');
      expect(prisma.programState.update).toHaveBeenCalledTimes(1);
    });

    it('logs and survives a persistence failure', async () => {
      const { prisma, service } = await activeService();
      prisma.programState.update.mockRejectedValue(new Error('write failed'));
      service.noteSongStarted('radio', 'A');
      await flush();
      expect(errorSpy).toHaveBeenCalled();
    });
  });

  describe('recordDecision', () => {
    const decision = {
      mode: 'on' as const,
      outcome: 'selected' as const,
      currentSongId: 1,
      proposedSongId: 2,
      playedSongId: 2,
      score: 0.9,
      runnerUps: [],
    };

    it('stores a decision', async () => {
      const { prisma, service } = setup();
      service.recordDecision('radio', decision);
      await flush();
      expect(prisma.similarityDecision.create).toHaveBeenCalledWith({
        data: { programId: 'radio', ...decision },
      });
      expect(prisma.similarityDecision.findFirst).not.toHaveBeenCalled();
    });

    it('prunes old decisions every 25 inserts', async () => {
      const { prisma, service } = setup();
      prisma.similarityDecision.findFirst.mockResolvedValue({ id: 10 });
      for (let i = 0; i < 25; i += 1) {
        service.recordDecision('radio', decision);
        await flush();
      }
      expect(prisma.similarityDecision.deleteMany).toHaveBeenCalledWith({
        where: { programId: 'radio', id: { lte: 10 } },
      });
    });

    it('skips deletion when there is nothing past the cap', async () => {
      const { prisma, service } = setup();
      prisma.similarityDecision.findFirst.mockResolvedValue(null);
      for (let i = 0; i < 25; i += 1) {
        service.recordDecision('radio', decision);
        await flush();
      }
      expect(prisma.similarityDecision.findFirst).toHaveBeenCalledTimes(1);
      expect(prisma.similarityDecision.deleteMany).not.toHaveBeenCalled();
    });

    it('counts and logs a persistence failure', async () => {
      const { prisma, metrics, service } = setup();
      prisma.similarityDecision.create.mockRejectedValue(new Error('nope'));
      service.recordDecision('radio', decision);
      await flush();
      expect(metrics.recordSimilarityAction).toHaveBeenCalledWith(
        'decision-persistence-failed',
      );
      expect(errorSpy).toHaveBeenCalled();
    });
  });

  describe('listDecisions', () => {
    it('labels songs and tolerates missing ones', async () => {
      const { prisma, service } = setup();
      prisma.similarityDecision.findMany.mockResolvedValue([
        {
          id: 2,
          mode: 'on',
          outcome: 'selected',
          createdAt: new Date(0),
          score: 0.9,
          currentSongId: 1,
          proposedSongId: 2,
          playedSongId: null,
          runnerUps: [],
        },
      ]);
      prisma.song.findMany.mockResolvedValue([
        { id: 1, artist: 'A', title: 'One' },
      ]);
      const rows = await service.listDecisions('radio', 10);
      expect(rows[0].current).toEqual({ songId: 1, artist: 'A', title: 'One' });
      expect(rows[0].proposed).toEqual({ songId: 2, artist: '', title: '' });
      expect(rows[0].played).toBeNull();
    });

    it('bounds the limit', async () => {
      const { prisma, service } = setup();
      prisma.similarityDecision.findMany.mockResolvedValue([]);
      prisma.song.findMany.mockResolvedValue([]);
      await service.listDecisions('radio', 9999);
      expect(prisma.similarityDecision.findMany).toHaveBeenLastCalledWith(
        expect.objectContaining({ take: 200 }),
      );
      await service.listDecisions('radio', Number.NaN);
      expect(prisma.similarityDecision.findMany).toHaveBeenLastCalledWith(
        expect.objectContaining({ take: 50 }),
      );
      await service.listDecisions('radio');
      expect(prisma.similarityDecision.findMany).toHaveBeenLastCalledWith(
        expect.objectContaining({ take: 50 }),
      );
    });
  });

  describe('getCoverage', () => {
    it('reports missing songs from the saved window', async () => {
      const { prisma, service } = setup();
      prisma.radioSettings.findFirst.mockResolvedValue({
        similarityWindowSeconds: 45,
      });
      prisma.song.count.mockResolvedValue(10);
      prisma.$queryRaw.mockResolvedValue([{ count: BigInt(4) }]);
      expect(await service.getCoverage('radio')).toEqual({
        model: SIMILARITY_MODEL,
        windowSeconds: 45,
        enabledSongs: 10,
        embeddedSongs: 4,
        missingSongs: 6,
      });
    });

    it('falls back to the cached window and an empty count', async () => {
      const { prisma, service } = setup();
      prisma.radioSettings.findFirst.mockResolvedValue(null);
      prisma.song.count.mockResolvedValue(2);
      prisma.$queryRaw.mockResolvedValue([]);
      const coverage = await service.getCoverage('radio');
      expect(coverage.windowSeconds).toBe(30);
      expect(coverage.missingSongs).toBe(2);
    });

    it('never reports negative missing songs', async () => {
      const { prisma, service } = setup();
      prisma.radioSettings.findFirst.mockResolvedValue(null);
      prisma.song.count.mockResolvedValue(1);
      prisma.$queryRaw.mockResolvedValue([{ count: BigInt(3) }]);
      expect((await service.getCoverage('radio')).missingSongs).toBe(0);
    });
  });

  describe('exportSongs', () => {
    const sequence = [
      { type: 'song', id: 'i1', songId: 1, artist: 'A', title: 'One' },
    ];

    it('rejects an unknown program', async () => {
      const { prisma, service } = setup();
      prisma.programState.findUnique.mockResolvedValue(null);
      await expect(service.exportSongs('x', 'catalog', false)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('exports the whole catalog with known hashes', async () => {
      const { prisma, service } = setup();
      prisma.programState.findUnique.mockResolvedValue({
        songSequence: [],
        radioSettings: { similarityWindowSeconds: 20 },
      });
      prisma.song.findMany.mockResolvedValue([
        { id: 1, artist: 'A', title: 'One', audioUrl: 'u1' },
        { id: 2, artist: 'B', title: 'Two', audioUrl: 'u2' },
        { id: 3, artist: 'C', title: 'Three', audioUrl: 'u3' },
      ]);
      prisma.$queryRaw.mockResolvedValue([
        { songId: 1, segment: 'opening', audioSha256: sha },
        { songId: 1, segment: 'closing', audioSha256: sha },
        { songId: 2, segment: 'opening', audioSha256: sha },
        { songId: 3, segment: 'opening', audioSha256: sha },
        { songId: 3, segment: 'closing', audioSha256: 'b'.repeat(64) },
      ]);
      const all = await service.exportSongs('radio', 'catalog', false);
      expect(all.windowSeconds).toBe(20);
      // Song 2 has one segment only; song 3 has two different hashes.
      expect(all.songs.map((s) => s.existingAudioSha256)).toEqual([
        sha,
        null,
        null,
      ]);
      expect(prisma.song.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { enabled: true } }),
      );
      const missing = await service.exportSongs('radio', 'catalog', true);
      expect(missing.songs.map((s) => s.songId)).toEqual([2]);
    });

    it('limits the sequence scope to playlist songs', async () => {
      const { prisma, service } = setup();
      prisma.programState.findUnique.mockResolvedValue({
        songSequence: sequence,
        radioSettings: null,
      });
      prisma.song.findMany.mockResolvedValue([]);
      prisma.$queryRaw.mockResolvedValue([]);
      const result = await service.exportSongs('radio', 'sequence', false);
      expect(result.windowSeconds).toBe(30);
      expect(prisma.song.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { enabled: true, id: { in: expect.any(Array) as number[] } },
        }),
      );
    });
  });

  describe('storeEmbeddings', () => {
    const header = {
      schema: 1,
      model: { ...SIMILARITY_MODEL },
      windowSeconds: 30,
    };
    const song = (songId: number, extra: Record<string, unknown> = {}) => ({
      songId,
      audioSha256: sha,
      opening: unit(0),
      closing: unit(1),
      ...extra,
    });

    it('rejects an invalid header', async () => {
      const { service } = setup();
      await expect(service.storeEmbeddings({ schema: 2 })).rejects.toThrow(
        BadRequestException,
      );
    });

    it('rejects an oversized request', async () => {
      const { service } = setup();
      const songs = Array.from({ length: 26 }, (_, i) => song(i + 1));
      await expect(
        service.storeEmbeddings({ ...header, songs }),
      ).rejects.toThrow('at most 25');
    });

    it('stores valid songs and reports each rejection', async () => {
      const { prisma, service } = setup();
      prisma.song.findMany.mockResolvedValue([{ id: 1 }, { id: 2 }]);
      const result = await service.storeEmbeddings({
        ...header,
        songs: [
          song(1),
          song(2, { opening: [1] }),
          song(3),
          null,
          song(1.5 as number),
        ],
      });
      expect(result.results).toEqual([
        { songId: 1, status: 'stored' },
        { songId: 2, status: 'rejected', reason: expect.any(String) as string },
        { songId: 3, status: 'rejected', reason: 'unknown song' },
        { songId: null, status: 'rejected', reason: 'invalid entry' },
        { songId: null, status: 'rejected', reason: 'invalid songId' },
      ]);
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(prisma.$executeRaw).toHaveBeenCalledTimes(2);
    });

    it('reports a storage failure for one song and continues', async () => {
      const { prisma, service } = setup();
      prisma.song.findMany.mockResolvedValue([{ id: 1 }, { id: 2 }]);
      prisma.$transaction
        .mockRejectedValueOnce(new Error('insert failed'))
        .mockResolvedValueOnce([]);
      const result = await service.storeEmbeddings({
        ...header,
        songs: [song(1), song(2)],
      });
      expect(result.results.map((r) => r.status)).toEqual([
        'rejected',
        'stored',
      ]);
      expect(result.results[0].reason).toBe('storage failed');
    });

    it('refreshes the cache after storing when a station is active', async () => {
      const ctx = await activeService();
      ctx.prisma.song.findMany.mockResolvedValue([{ id: 1 }]);
      ctx.prisma.$queryRaw.mockClear();
      await ctx.service.storeEmbeddings({ ...header, songs: [song(1)] });
      expect(ctx.prisma.$queryRaw).toHaveBeenCalledTimes(1);
    });

    it('still succeeds when the cache refresh fails', async () => {
      const ctx = await activeService();
      ctx.prisma.song.findMany.mockResolvedValue([{ id: 1 }]);
      ctx.prisma.$queryRaw.mockRejectedValue(new Error('refresh failed'));
      const result = await ctx.service.storeEmbeddings({
        ...header,
        songs: [song(1)],
      });
      expect(result.results[0].status).toBe('stored');
      expect(errorSpy).toHaveBeenCalled();
    });
  });

  describe('evaluation fixtures', () => {
    it('starts empty until the operator supplies catalog pairs', () => {
      expect(SIMILARITY_EVALUATION_PAIRS).toEqual({
        mustRankHigh: [],
        mustNeverPass: [],
      });
    });
  });
});
