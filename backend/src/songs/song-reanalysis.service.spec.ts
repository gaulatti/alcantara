import { BadRequestException, ConflictException } from '@nestjs/common';
import { SongReanalysisService } from './song-reanalysis.service';

// gaulatti/alcantara#235: a song on air is never queued for a new analysis, and that is checked again at queue time.
const NOW = new Date('2026-11-24T10:00:00.000Z');

function build(
  opts: { analysed?: string[]; holding?: Record<number, string[]> } = {},
) {
  const prisma = {
    song: {
      findMany: jest.fn(async ({ where }: any) =>
        (where.id.in as number[]).map((id) => ({
          id,
          audioUrl: `https://media.test/${id}.mp3`,
        })),
      ),
    },
    mediaAssetAnalysis: {
      findMany: jest.fn(async () =>
        (opts.analysed ?? []).map((assetId) => ({ assetId })),
      ),
      updateMany: jest.fn(async ({ where }: any) => ({
        count: where.assetId.in.length,
      })),
    },
  };
  const programs = {
    programsHoldingSongs: jest.fn(
      async (songs: Array<{ id: number }>) =>
        new Map(songs.map((song) => [song.id, opts.holding?.[song.id] ?? []])),
    ),
  };
  const service = new SongReanalysisService(prisma as never, programs as never);
  return { service, prisma, programs };
}

describe('SongReanalysisService', () => {
  it('makes the finished analyses of songs that are not on air due now, keeping their cues, and lists the songs it skipped', async () => {
    const { service, prisma, programs } = build({
      analysed: ['song:1', 'song:3'],
    });
    await expect(service.request([1, 2, 3], NOW)).resolves.toEqual({
      requested: 2,
      skipped: [2],
    });
    expect(programs.programsHoldingSongs).toHaveBeenCalledWith([
      { id: 1, audioUrl: 'https://media.test/1.mp3' },
      { id: 2, audioUrl: 'https://media.test/2.mp3' },
      { id: 3, audioUrl: 'https://media.test/3.mp3' },
    ]);
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

  it('refuses with 409 on_air, listing each song and its programs, and queues none of the batch', async () => {
    const { service, prisma } = build({
      analysed: ['song:1', 'song:2', 'song:3'],
      holding: { 2: ['radio-1'], 3: ['radio-1', 'tv'] },
    });
    const error = await service.request([1, 2, 3], NOW).catch((e) => e);
    expect(error).toBeInstanceOf(ConflictException);
    expect(error.getStatus()).toBe(409);
    expect(error.getResponse()).toEqual({
      code: 'on_air',
      message:
        'songs on air cannot be analysed again: 2 (radio-1); 3 (radio-1, tv)',
      songs: { 2: ['radio-1'], 3: ['radio-1', 'tv'] },
    });
    expect(prisma.mediaAssetAnalysis.updateMany).not.toHaveBeenCalled();
  });

  it('checks again at queue time: a song that went on air after the plan is refused', async () => {
    const { service, programs, prisma } = build({ analysed: ['song:1'] });
    await service.request([1], NOW);
    expect(prisma.mediaAssetAnalysis.updateMany).toHaveBeenCalledTimes(1);
    programs.programsHoldingSongs.mockResolvedValueOnce(
      new Map([[1, ['radio-1']]]),
    );
    await expect(service.request([1], NOW)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(prisma.mediaAssetAnalysis.updateMany).toHaveBeenCalledTimes(1);
  });

  it('reads which programs hold the named songs, without queuing', async () => {
    const { service, prisma } = build({ holding: { 4: ['radio-1'] } });
    await expect(service.onAir([4, 5])).resolves.toEqual(
      new Map([
        [4, ['radio-1']],
        [5, []],
      ]),
    );
    expect(prisma.mediaAssetAnalysis.updateMany).not.toHaveBeenCalled();
  });

  it('queues nothing when no named song has a finished analysis', async () => {
    const { service } = build();
    await expect(service.request([5])).resolves.toEqual({
      requested: 0,
      skipped: [5],
    });
  });

  it('accepts exactly 25 songs and refuses 26, none, duplicates and anything that is not a song id', async () => {
    const { service, prisma } = build();
    const ids = Array.from({ length: 25 }, (_, index) => index + 1);
    await expect(service.request(ids)).resolves.toMatchObject({ requested: 0 });
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
      await expect(service.request(bad)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      await expect(service.onAir(bad)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    }
    expect(prisma.mediaAssetAnalysis.findMany).toHaveBeenCalledTimes(1);
  });
});

describe('SongReanalysisService dependency metadata', () => {
  it('records Object for constructor types that are not yet defined', () => {
    jest.isolateModules(() => {
      jest.doMock('../prisma.service', () => ({ PrismaService: undefined }));
      jest.doMock('../program/program.service', () => ({
        ProgramService: undefined,
      }));
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const loaded = require('./song-reanalysis.service') as {
        SongReanalysisService: new (...args: never[]) => unknown;
      };
      const types = Reflect.getMetadata(
        'design:paramtypes',
        loaded.SongReanalysisService,
      ) as Array<{ name: string }>;
      expect(types.map((type) => type.name)).toEqual(['Object', 'Object']);
    });
    jest.dontMock('../prisma.service');
    jest.dontMock('../program/program.service');
  });
});
