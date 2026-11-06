/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/require-await -- Jest mocks are intentionally loosely typed. */
import { BadRequestException } from '@nestjs/common';
import { ScenesService } from './scenes.service';

const TYPE = 'modoitaliano-bracket';

function build() {
  const prisma = {
    scene: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
    layout: { findUnique: jest.fn() },
    externalSource: { findFirst: jest.fn() },
  };
  const program = {
    getProgramIdsByAssignedScene: jest.fn().mockResolvedValue([]),
    getProgramIdsByActiveScene: jest.fn().mockResolvedValue([]),
    clearActiveScene: jest.fn().mockResolvedValue([]),
    getState: jest.fn(),
    broadcastUpdate: jest.fn(),
  };
  const service = new ScenesService(prisma as never, program as never);
  prisma.layout.findUnique.mockResolvedValue({ componentType: 'text' });
  prisma.scene.update.mockImplementation(
    async ({ where, data }: { where: { id: number }; data: unknown }) => ({
      id: where.id,
      ...(data as object),
    }),
  );
  return { service, prisma, program };
}

type Match = {
  id: number;
  songAId?: unknown;
  songBId?: unknown;
  winnerId?: unknown;
};

function sceneWith(bracket: unknown, extra: Record<string, unknown> = {}) {
  return {
    id: 1,
    layoutId: 2,
    metadata: JSON.stringify({ keep: 'me', ...extra, [TYPE]: bracket }),
  };
}

function lastMetadata(prisma: ReturnType<typeof build>['prisma']) {
  const call = prisma.scene.update.mock.calls.at(-1)![0];
  return JSON.parse(call.data.metadata);
}

function match(
  id: number,
  a: number | null,
  b: number | null,
  w = null,
): Match {
  return { id, songAId: a, songBId: b, winnerId: w };
}

describe('ScenesService basic CRUD', () => {
  it('lists and finds scenes with their layout', async () => {
    const { service, prisma } = build();
    prisma.scene.findMany.mockResolvedValue([1]);
    prisma.scene.findUnique.mockResolvedValue({ id: 2 });
    await expect(service.findAll()).resolves.toEqual([1]);
    await expect(service.findOne(2)).resolves.toEqual({ id: 2 });
    expect(prisma.scene.findMany).toHaveBeenCalledWith({
      include: { layout: true },
      orderBy: { createdAt: 'desc' },
    });
    expect(prisma.scene.findUnique).toHaveBeenCalledWith({
      where: { id: 2 },
      include: { layout: true },
    });
  });

  it('creates a scene serializing metadata', async () => {
    const { service, prisma } = build();
    prisma.scene.create.mockResolvedValue({ id: 1 });
    await service.create({
      name: 'S',
      layoutId: 2,
      chyronText: 'c',
      metadata: { a: 1 },
      externalSourceId: 'src',
    });
    expect(prisma.scene.create).toHaveBeenCalledWith({
      data: {
        name: 'S',
        layoutId: 2,
        chyronText: 'c',
        metadata: '{"a":1}',
        externalSourceId: 'src',
      },
      include: { layout: true },
    });
  });

  it('creates a scene with null metadata and null external source by default', async () => {
    const { service, prisma } = build();
    prisma.scene.create.mockResolvedValue({ id: 1 });
    await service.create({ name: 'S', layoutId: 2 });
    expect(prisma.scene.create).toHaveBeenCalledWith({
      data: {
        name: 'S',
        layoutId: 2,
        chyronText: undefined,
        metadata: null,
        externalSourceId: null,
      },
      include: { layout: true },
    });
  });

  it('updates chyron and notifies programs where the scene is active', async () => {
    const { service, prisma, program } = build();
    program.getProgramIdsByActiveScene.mockResolvedValue(['a', 'b']);
    const scene = await service.updateChyron(3, 'headline');
    expect(prisma.scene.update).toHaveBeenCalledWith({
      where: { id: 3 },
      data: { chyronText: 'headline' },
      include: { layout: true },
    });
    expect(program.broadcastUpdate).toHaveBeenCalledTimes(2);
    expect(program.broadcastUpdate).toHaveBeenCalledWith('a', {
      type: 'chyron_update',
      scene,
    });
  });

  it('removes a scene, clears it from active programs and refreshes assigned ones', async () => {
    const { service, prisma, program } = build();
    program.getProgramIdsByAssignedScene.mockResolvedValue(['a', 'b']);
    program.clearActiveScene.mockResolvedValue(['a']);
    program.getState.mockResolvedValue({ s: 1 });
    prisma.scene.delete.mockResolvedValue({ id: 4 });
    await expect(service.remove(4)).resolves.toEqual({ id: 4 });
    expect(program.broadcastUpdate).toHaveBeenNthCalledWith(1, 'a', {
      type: 'scene_cleared',
    });
    expect(program.broadcastUpdate).toHaveBeenCalledWith('b', {
      type: 'program_scenes_changed',
      state: { s: 1 },
    });
    expect(program.getState).toHaveBeenCalledTimes(2);
    expect(prisma.scene.delete).toHaveBeenCalledWith({ where: { id: 4 } });
  });

  it('removes a scene that is not assigned anywhere', async () => {
    const { service, prisma, program } = build();
    prisma.scene.delete.mockResolvedValue({ id: 4 });
    await service.remove(4);
    expect(program.broadcastUpdate).not.toHaveBeenCalled();
  });
});

describe('ScenesService.update', () => {
  it('writes only provided fields, serializes metadata and broadcasts', async () => {
    const { service, prisma, program } = build();
    prisma.scene.findUnique.mockResolvedValue({
      id: 1,
      layoutId: 2,
      externalSourceId: null,
    });
    program.getProgramIdsByAssignedScene.mockResolvedValue(['p1']);
    const scene = await service.update(1, {
      name: 'N',
      layoutId: 3,
      chyronText: 'c',
      metadata: { z: 1 },
      externalSourceId: null,
    });
    expect(prisma.layout.findUnique).toHaveBeenCalledWith({
      where: { id: 3 },
      select: { componentType: true },
    });
    expect(prisma.scene.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: {
        name: 'N',
        layoutId: 3,
        chyronText: 'c',
        metadata: '{"z":1}',
        externalSourceId: null,
      },
      include: { layout: true },
    });
    expect(program.broadcastUpdate).toHaveBeenCalledWith('p1', {
      type: 'scene_update',
      programId: 'p1',
      scene,
    });
  });

  it('updates with no fields and validates against the stored layout', async () => {
    const { service, prisma } = build();
    prisma.scene.findUnique.mockResolvedValue({
      id: 1,
      layoutId: 9,
      externalSourceId: 'ext',
    });
    await service.update(1, {});
    expect(prisma.layout.findUnique).toHaveBeenCalledWith({
      where: { id: 9 },
      select: { componentType: true },
    });
    expect(prisma.scene.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: {},
      include: { layout: true },
    });
  });

  it('keeps an existing video-stream source when externalSourceId is not provided', async () => {
    const { service, prisma } = build();
    prisma.layout.findUnique.mockResolvedValue({
      componentType: 'video-stream',
    });
    prisma.scene.findUnique.mockResolvedValue({
      id: 1,
      layoutId: 2,
      externalSourceId: 'ext',
    });
    prisma.externalSource.findFirst.mockResolvedValue({ id: 'ext' });
    await service.update(1, { name: 'x' });
    expect(prisma.externalSource.findFirst).toHaveBeenCalledWith({
      where: { id: 'ext', revokedAt: null },
      select: { id: true },
    });
  });

  it('rejects an explicit external source change to a provided id that is missing', async () => {
    const { service, prisma } = build();
    prisma.layout.findUnique.mockResolvedValue({
      componentType: 'video-stream',
    });
    prisma.scene.findUnique.mockResolvedValue({
      id: 1,
      layoutId: 2,
      externalSourceId: null,
    });
    prisma.externalSource.findFirst.mockResolvedValue(null);
    await expect(
      service.update(1, { externalSourceId: 'gone' }),
    ).rejects.toThrow(new BadRequestException('External source not found'));
    expect(prisma.scene.update).not.toHaveBeenCalled();
  });

  it('requires a source when a video-stream scene has none', async () => {
    const { service, prisma } = build();
    prisma.layout.findUnique.mockResolvedValue({
      componentType: 'video-stream',
    });
    prisma.scene.findUnique.mockResolvedValue({
      id: 1,
      layoutId: 2,
      externalSourceId: null,
    });
    await expect(service.update(1, { name: 'x' })).rejects.toThrow(
      'Video stream scenes require externalSourceId',
    );
  });

  it('rejects unknown scenes', async () => {
    const { service, prisma } = build();
    prisma.scene.findUnique.mockResolvedValue(null);
    await expect(service.update(1, {})).rejects.toThrow('Scene not found');
  });

  it('cancels a pending bracket draw so its timer never fires', async () => {
    jest.useFakeTimers();
    try {
      const { service, prisma, program } = build();
      prisma.scene.findUnique.mockResolvedValue({
        ...sceneWith({
          startRound: 'quarterfinals',
          randomSongPoolIds: [1, 2],
          matches: [],
        }),
        externalSourceId: null,
      });
      await service.drawModoItalianoBracket(1, { seed: 3 });
      program.broadcastUpdate.mockClear();
      await service.update(1, { name: 'renamed' });
      program.broadcastUpdate.mockClear();
      prisma.scene.update.mockClear();
      await jest.advanceTimersByTimeAsync(60_000);
      expect(prisma.scene.update).not.toHaveBeenCalled();
      expect(program.broadcastUpdate).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('ScenesService external source validation', () => {
  it('rejects a missing layout', async () => {
    const { service, prisma } = build();
    prisma.layout.findUnique.mockResolvedValue(null);
    await expect(service.create({ name: 'n', layoutId: 1 })).rejects.toThrow(
      new BadRequestException('Layout not found'),
    );
  });

  it('rejects source URLs hidden in video-stream metadata at any depth', async () => {
    const { service, prisma } = build();
    prisma.layout.findUnique.mockResolvedValue({
      componentType: 'video-stream',
    });
    for (const metadata of [
      { sourceUrl: 'http://x' },
      { a: { b: [{ c: { sourceUrl: 'http://x' } }] } },
      [{ sourceUrl: 'x' }],
    ]) {
      await expect(
        service.create({
          name: 'n',
          layoutId: 1,
          externalSourceId: 's',
          metadata,
        }),
      ).rejects.toThrow(
        'Video stream scenes reference externalSourceId, not a URL',
      );
    }
  });

  it('accepts video-stream scenes with innocuous metadata and a live source', async () => {
    const { service, prisma } = build();
    prisma.layout.findUnique.mockResolvedValue({
      componentType: 'video-stream',
    });
    prisma.externalSource.findFirst.mockResolvedValue({ id: 's' });
    prisma.scene.create.mockResolvedValue({ id: 1 });
    await expect(
      service.create({
        name: 'n',
        layoutId: 1,
        externalSourceId: 's',
        metadata: { title: 'x', list: [1, 'a', null, { k: 2 }], n: null },
      }),
    ).resolves.toEqual({ id: 1 });
  });

  it('requires an externalSourceId for video-stream scenes', async () => {
    const { service, prisma } = build();
    prisma.layout.findUnique.mockResolvedValue({
      componentType: 'video-stream',
    });
    await expect(service.create({ name: 'n', layoutId: 1 })).rejects.toThrow(
      'Video stream scenes require externalSourceId',
    );
  });
});

describe('ScenesService.drawModoItalianoBracket', () => {
  afterEach(() => jest.useRealTimers());

  const quarter = (extra: Record<string, unknown> = {}) => ({
    startRound: 'quarterfinals',
    randomSongPoolIds: [10, 11, 12],
    ...extra,
  });

  it('rejects unknown scenes', async () => {
    const { service, prisma } = build();
    prisma.scene.findUnique.mockResolvedValue(null);
    await expect(service.drawModoItalianoBracket(1, {})).rejects.toThrow(
      'Scene not found',
    );
  });

  it('rejects brackets that do not start at the quarterfinals', async () => {
    const { service, prisma } = build();
    for (const metadata of [
      JSON.stringify({ [TYPE]: { startRound: 'final' } }),
      JSON.stringify({ [TYPE]: 'not-an-object' }),
      null,
      'not json',
      '[1]',
      'null',
    ]) {
      prisma.scene.findUnique.mockResolvedValue({ id: 1, metadata });
      await expect(
        service.drawModoItalianoBracket(1, { componentType: 'other' }),
      ).rejects.toThrow(
        'Bracket draw is only available for quarterfinal brackets',
      );
    }
  });

  it('rejects when the pool is exhausted or no opening slot remains', async () => {
    const { service, prisma } = build();
    prisma.scene.findUnique.mockResolvedValue(
      sceneWith({ startRound: 'quarterfinals', randomSongPoolIds: 'none' }),
    );
    await expect(service.drawModoItalianoBracket(1, {})).rejects.toThrow(
      'No available songs or bracket slots remain for this draw',
    );
    prisma.scene.findUnique.mockResolvedValue(
      sceneWith(quarter({ randomSongPoolIds: [] })),
    );
    await expect(service.drawModoItalianoBracket(1, {})).rejects.toThrow(
      'No available songs or bracket slots remain for this draw',
    );

    const full = [
      match(9, 1, 2),
      match(10, 3, 4),
      match(11, 5, 6),
      match(12, 7, 8),
    ];
    prisma.scene.findUnique.mockResolvedValue(
      sceneWith(quarter({ matches: full, randomSongPoolIds: [50] })),
    );
    await expect(service.drawModoItalianoBracket(1, {})).rejects.toThrow(
      'No available songs or bracket slots remain for this draw',
    );

    prisma.scene.findUnique.mockResolvedValue(
      sceneWith(
        quarter({ matches: [match(9, 10, null)], randomSongPoolIds: [10] }),
      ),
    );
    await expect(service.drawModoItalianoBracket(1, {})).rejects.toThrow(
      'No available songs or bracket slots remain for this draw',
    );
  });

  it('broadcasts a seeded shuffle, then fills the next slot when the timer fires', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-02-01T00:00:00Z'));
    const { service, prisma, program } = build();
    const bracket = quarter({
      randomSongPoolIds: ['10', 11, 12, 11, 0, 1.5, 'x', 99],
      matches: [match(9, 99, null)],
      drawDurationSeconds: 2.9,
    });
    prisma.scene.findUnique.mockResolvedValue(sceneWith(bracket));
    program.getProgramIdsByAssignedScene.mockResolvedValue(['p1', 'p2']);

    const result = await service.drawModoItalianoBracket(1, {
      componentType: TYPE,
      seed: 7.9,
    });

    const now = Date.now();
    expect(result).toEqual({ drawId: now, durationSeconds: 2, sceneId: 1 });
    const start = program.broadcastUpdate.mock.calls[0][1];
    expect(start).toMatchObject({
      type: 'modoitaliano_bracket_draw_start',
      sceneId: 1,
      componentType: TYPE,
      drawId: now,
      durationSeconds: 2,
    });
    expect([...start.songIds].sort()).toEqual([10, 11, 12]);
    expect(program.broadcastUpdate).toHaveBeenCalledTimes(2);

    // the same seed yields the same order
    program.broadcastUpdate.mockClear();
    await service.drawModoItalianoBracket(1, { seed: 7 });
    expect(program.broadcastUpdate.mock.calls[0][1].songIds).toEqual(
      start.songIds,
    );

    program.broadcastUpdate.mockClear();
    prisma.scene.update.mockClear();
    await jest.advanceTimersByTimeAsync(2000);
    const saved = lastMetadata(prisma);
    expect(saved.keep).toBe('me');
    expect(saved[TYPE].matches[8]).toMatchObject({
      songAId: 99,
      songBId: start.songIds[0],
    });
    const types = program.broadcastUpdate.mock.calls.map((c) => c[1].type);
    expect(types).toContain('scene_update');
    expect(types).toContain('modoitaliano_bracket_draw_end');
  });

  it('falls back to the clock when the seed is not numeric and to default durations', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(12345);
    const { service, prisma } = build();
    prisma.scene.findUnique.mockResolvedValue(
      sceneWith(quarter({ drawSeed: 4.2 })),
    );
    await expect(
      service.drawModoItalianoBracket(1, { seed: undefined }),
    ).resolves.toEqual({ drawId: 12345, durationSeconds: 4, sceneId: 1 });

    prisma.scene.findUnique.mockResolvedValue(
      sceneWith(quarter({ drawDurationSeconds: -1, drawSeed: 'nope' })),
    );
    await expect(service.drawModoItalianoBracket(1, {})).resolves.toMatchObject(
      { durationSeconds: 5 },
    );
    prisma.scene.findUnique.mockResolvedValue(
      sceneWith(quarter({ drawDurationSeconds: 'x', drawSeed: 0 })),
    );
    await expect(service.drawModoItalianoBracket(1, {})).resolves.toMatchObject(
      { durationSeconds: 5 },
    );
  });

  it('replacing a draw cancels the previous timer', async () => {
    jest.useFakeTimers();
    const { service, prisma } = build();
    prisma.scene.findUnique.mockResolvedValue(
      sceneWith(quarter({ drawDurationSeconds: 3 })),
    );
    jest.setSystemTime(1000);
    await service.drawModoItalianoBracket(1, { seed: 1 });
    jest.setSystemTime(1500);
    await service.drawModoItalianoBracket(1, { seed: 1 });
    prisma.scene.update.mockClear();
    await jest.advanceTimersByTimeAsync(10_000);
    // only the second draw completes
    expect(prisma.scene.update).toHaveBeenCalledTimes(1);
  });
});

describe('ScenesService draw completion guards', () => {
  const complete = (service: ScenesService, ...args: unknown[]) =>
    (
      service as unknown as {
        completeModoItalianoBracketDraw: (...a: unknown[]) => Promise<void>;
      }
    ).completeModoItalianoBracketDraw(...args);
  const draws = (service: ScenesService) =>
    (service as unknown as { modoItalianoBracketDraws: Map<number, unknown> })
      .modoItalianoBracketDraws;

  it('ignores completions without a matching active draw', async () => {
    const { service, prisma } = build();
    await complete(service, 1, TYPE, 5, 10);
    draws(service).set(1, { timer: setTimeout(() => undefined, 0), drawId: 6 });
    await complete(service, 1, TYPE, 5, 10);
    expect(prisma.scene.findUnique).not.toHaveBeenCalled();
    expect(draws(service).size).toBe(1);
    clearTimeout((draws(service).get(1) as { timer: NodeJS.Timeout }).timer);
  });

  it('clears the draw and stops when the scene vanished', async () => {
    const { service, prisma } = build();
    draws(service).set(1, { timer: setTimeout(() => undefined, 0), drawId: 5 });
    prisma.scene.findUnique.mockResolvedValue(null);
    await complete(service, 1, TYPE, 5, 10);
    expect(draws(service).has(1)).toBe(false);
    expect(prisma.scene.update).not.toHaveBeenCalled();
  });

  it('stops when every opening slot is already filled', async () => {
    const { service, prisma, program } = build();
    draws(service).set(1, { timer: setTimeout(() => undefined, 0), drawId: 5 });
    prisma.scene.findUnique.mockResolvedValue(
      sceneWith({
        matches: [
          match(9, 1, 2),
          match(10, 3, 4),
          match(11, 5, 6),
          match(12, 7, 8),
        ],
      }),
    );
    await complete(service, 1, TYPE, 5, 10);
    expect(prisma.scene.update).not.toHaveBeenCalled();
    expect(program.broadcastUpdate).not.toHaveBeenCalled();
  });

  it('tolerates scenes whose bracket metadata is missing', async () => {
    const { service, prisma } = build();
    draws(service).set(1, { timer: setTimeout(() => undefined, 0), drawId: 5 });
    prisma.scene.findUnique.mockResolvedValue({ id: 1, metadata: '{}' });
    await complete(service, 1, TYPE, 5, 10);
    expect(lastMetadata(prisma)[TYPE].matches[8].songAId).toBe(10);
  });
});

describe('ScenesService.voteModoItalianoBracket', () => {
  const voters = [
    { id: 'a', name: 'A' },
    { id: 'b', name: 'B' },
    { id: 'c', name: 'C' },
  ];
  const vote = (
    service: ScenesService,
    data: Parameters<ScenesService['voteModoItalianoBracket']>[1],
  ) => service.voteModoItalianoBracket(1, data);

  it('rejects malformed votes before reading the scene', async () => {
    const { service, prisma } = build();
    const bad = [
      { matchId: 0, voterId: 'a' },
      { matchId: 16, voterId: 'a' },
      { matchId: 1.5, voterId: 'a' },
      { matchId: Number.NaN, voterId: 'a' },
      { matchId: 1 },
      { matchId: 1, voterId: '   ' },
      { matchId: 1, voterId: 7 as never },
    ];
    for (const data of bad) {
      await expect(vote(service, data)).rejects.toThrow('Invalid vote');
    }
    expect(prisma.scene.findUnique).not.toHaveBeenCalled();
  });

  it('rejects unknown scenes and unknown voters', async () => {
    const { service, prisma } = build();
    prisma.scene.findUnique.mockResolvedValueOnce(null);
    await expect(vote(service, { matchId: 1, voterId: 'a' })).rejects.toThrow(
      'Scene not found',
    );
    for (const v of [
      voters,
      'nope',
      [null, 5, { id: 'a' }, { id: 1, name: 'x' }, { name: 'a' }],
    ]) {
      prisma.scene.findUnique.mockResolvedValue(
        sceneWith({ voters: v, matches: [match(1, 1, 2)] }),
      );
      await expect(
        vote(service, { matchId: 1, voterId: 'zzz' }),
      ).rejects.toThrow('Unknown voter');
    }
    prisma.scene.findUnique.mockResolvedValue({ id: 1, metadata: null });
    await expect(vote(service, { matchId: 1, voterId: 'a' })).rejects.toThrow(
      'Unknown voter',
    );
  });

  it('rejects votes for songs outside the match', async () => {
    const { service, prisma } = build();
    prisma.scene.findUnique.mockResolvedValue(
      sceneWith({ voters, matches: [match(1, 1, 2)] }),
    );
    await expect(
      vote(service, { matchId: 1, voterId: 'a', songId: 3 }),
    ).rejects.toThrow('Vote must be for a song in this match');
  });

  it('records votes without a winner until a majority is reached', async () => {
    const { service, prisma, program } = build();
    prisma.scene.findUnique.mockResolvedValue(
      sceneWith({ voters, matches: [match(1, 1, 2)] }),
    );
    program.getProgramIdsByAssignedScene.mockResolvedValue(['p']);
    await vote(service, {
      componentType: 'other',
      matchId: 1,
      voterId: ' a ',
      songId: 1,
    });
    const saved = lastMetadata(prisma);
    expect(saved.keep).toBe('me');
    expect(saved[TYPE]).toMatchObject({
      matchVotes: { '1': { a: 1 } },
      activeVotingMatchId: 1,
      votingWinnerId: null,
      votingResultStartedAt: null,
    });
    expect(saved[TYPE].matches[0].winnerId).toBeNull();
    expect(program.broadcastUpdate).toHaveBeenCalledWith(
      'p',
      expect.objectContaining({ type: 'scene_update', programId: 'p' }),
    );
  });

  it('declares the winner on majority and advances them to the next round', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(5000);
    try {
      const { service, prisma } = build();
      prisma.scene.findUnique.mockResolvedValue(
        sceneWith({
          voters,
          matches: [match(1, 1, 2)],
          matchVotes: { '1': { a: 2, c: 99 }, '2': { z: 1 } },
        }),
      );
      await vote(service, { matchId: 1, voterId: 'b', songId: 2 });
      const bracket = lastMetadata(prisma)[TYPE];
      expect(bracket.votingWinnerId).toBe(2);
      expect(bracket.votingResultStartedAt).toBe(5000);
      expect(bracket.matches[0].winnerId).toBe(2);
      expect(bracket.matches[8]).toMatchObject({ songAId: 2 });
      expect(bracket.matchVotes['2']).toEqual({ z: 1 });
    } finally {
      jest.useRealTimers();
    }
  });

  it('declares a winner on the final without advancing anyone', async () => {
    const { service, prisma } = build();
    prisma.scene.findUnique.mockResolvedValue(
      sceneWith({
        voters: [{ id: 'a', name: 'A' }],
        matches: [match(15, 7, 8)],
      }),
    );
    await vote(service, { matchId: 15, voterId: 'a', songId: 8 });
    const bracket = lastMetadata(prisma)[TYPE];
    expect(bracket.votingWinnerId).toBe(8);
    expect(bracket.matches[14].winnerId).toBe(8);
    expect(bracket.matches[13]).toMatchObject({ songAId: null, songBId: null });
  });

  it('feeds the side B slot for even matches and supports abstaining votes', async () => {
    const { service, prisma } = build();
    prisma.scene.findUnique.mockResolvedValue(
      sceneWith({
        voters: [{ id: 'a', name: 'A' }],
        matches: [match(2, 3, 4)],
      }),
    );
    await vote(service, { matchId: 2, voterId: 'a', songId: 4 });
    expect(lastMetadata(prisma)[TYPE].matches[8].songBId).toBe(4);

    await vote(service, {
      componentType: TYPE,
      matchId: 2,
      voterId: 'a',
      songId: null,
    });
    const abstain = lastMetadata(prisma)[TYPE];
    expect(abstain.matchVotes['2'].a).toBeNull();
    expect(abstain.votingWinnerId).toBeNull();
  });

  it('counts only valid, matching votes and never crowns an empty slot', async () => {
    const { service, prisma } = build();
    prisma.scene.findUnique.mockResolvedValue(
      sceneWith({
        voters,
        matches: [match(1, 1, null)],
        matchVotes: { '1': { a: 1, b: 5 } },
      }),
    );
    await vote(service, { matchId: 1, voterId: 'c', songId: null });
    const bracket = lastMetadata(prisma)[TYPE];
    expect(bracket.votingWinnerId).toBeNull();
    expect(bracket.matches[0].winnerId).toBeNull();
  });
});

describe('ScenesService.openModoItalianoBracketVoting', () => {
  it('rejects invalid matches and unknown scenes', async () => {
    const { service, prisma } = build();
    for (const matchId of [0, 16, 2.5, Number.NaN, undefined]) {
      await expect(
        service.openModoItalianoBracketVoting(1, { matchId }),
      ).rejects.toThrow('Invalid match');
    }
    prisma.scene.findUnique.mockResolvedValue(null);
    await expect(
      service.openModoItalianoBracketVoting(1, { matchId: 1 }),
    ).rejects.toThrow('Scene not found');
  });

  it('refuses matches that are not ready or already decided', async () => {
    const { service, prisma } = build();
    for (const m of [
      match(1, null, 2),
      match(1, 1, null),
      match(1, 1, 2, 1 as never),
    ]) {
      prisma.scene.findUnique.mockResolvedValue(sceneWith({ matches: [m] }));
      await expect(
        service.openModoItalianoBracketVoting(1, { matchId: 1 }),
      ).rejects.toThrow('This match is not open for voting');
    }
    prisma.scene.findUnique.mockResolvedValue({ id: 1, metadata: null });
    await expect(
      service.openModoItalianoBracketVoting(1, { matchId: 3 }),
    ).rejects.toThrow('This match is not open for voting');
    prisma.scene.findUnique.mockResolvedValue(sceneWith('scalar' as never));
    await expect(
      service.openModoItalianoBracketVoting(1, {
        matchId: 3,
        componentType: 'x',
      }),
    ).rejects.toThrow('This match is not open for voting');
  });

  it('opens voting on a ready match and resets the result state', async () => {
    const { service, prisma, program } = build();
    prisma.scene.findUnique.mockResolvedValue(
      sceneWith({
        matches: [match(1, 1, 2)],
        votingWinnerId: 9,
        votingResultStartedAt: 1,
        activeVotingMatchId: 4,
      }),
    );
    program.getProgramIdsByAssignedScene.mockResolvedValue(['p']);
    await service.openModoItalianoBracketVoting(1, { matchId: 1 });
    expect(lastMetadata(prisma)[TYPE]).toMatchObject({
      activeVotingMatchId: 1,
      votingWinnerId: null,
      votingResultStartedAt: null,
    });
    expect(program.broadcastUpdate).toHaveBeenCalledTimes(1);
  });
});

describe('ScenesService bracket normalization', () => {
  it('ignores malformed match entries and keeps valid ones', async () => {
    const { service, prisma } = build();
    prisma.scene.findUnique.mockResolvedValue(
      sceneWith({
        matches: [
          null,
          'str',
          { id: 0, songAId: 1, songBId: 2 },
          { id: 16, songAId: 1, songBId: 2 },
          { id: 'x', songAId: 1, songBId: 2 },
          { id: 1.5, songAId: 1, songBId: 2 },
          { id: 3, songAId: 5, songBId: '6', winnerId: 5 },
          { id: 4, songAId: 7.5, songBId: 8 },
          { id: 5, songAId: 1, songBId: 2 },
        ],
      }),
    );
    await expect(
      service.openModoItalianoBracketVoting(1, { matchId: 3 }),
    ).rejects.toThrow('This match is not open for voting');
    await expect(
      service.openModoItalianoBracketVoting(1, { matchId: 4 }),
    ).rejects.toThrow('This match is not open for voting');
    await service.openModoItalianoBracketVoting(1, {
      componentType: TYPE,
      matchId: 5,
    });
    expect(lastMetadata(prisma)[TYPE].activeVotingMatchId).toBe(5);
  });
});
