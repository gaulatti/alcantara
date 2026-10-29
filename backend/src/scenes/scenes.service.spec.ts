import { BadRequestException } from '@nestjs/common';
import { ScenesService } from './scenes.service';

function fixture(metadata: unknown = {}) {
  let scene: any = {
    id: 7,
    name: 'Opening',
    layoutId: 2,
    chyronText: '',
    externalSourceId: null,
    metadata:
      typeof metadata === 'string' ? metadata : JSON.stringify(metadata),
  };
  const prisma = {
    scene: {
      findMany: jest.fn(async () => [scene]),
      findUnique: jest.fn(async () => scene),
      create: jest.fn(async (input: any) => ({ id: 8, ...input.data })),
      update: jest.fn(async (input: any) => {
        scene = { ...scene, ...input.data };
        return scene;
      }),
      delete: jest.fn(async () => scene),
    },
    layout: {
      findUnique: jest.fn().mockResolvedValue({ componentType: 'lower-third' }),
    },
    externalSource: {
      findFirst: jest.fn().mockResolvedValue({ id: 'source-1' }),
    },
  };
  const programs = {
    getProgramIdsByAssignedScene: jest
      .fn()
      .mockResolvedValue(['program-a', 'program-b']),
    getProgramIdsByActiveScene: jest.fn().mockResolvedValue(['program-a']),
    broadcastUpdate: jest.fn(),
    clearActiveScene: jest.fn().mockResolvedValue(['program-a']),
    getState: jest.fn(async (programId: string) => ({
      programId,
      activeSceneId: null,
    })),
  };
  const service = new ScenesService(prisma as any, programs as any);
  return { service, prisma, programs, current: () => scene };
}

const bracketMetadata = (extra: Record<string, unknown> = {}) => ({
  'modoitaliano-bracket': {
    startRound: 'quarterfinals',
    randomSongPoolIds: [1, 2, 3, 4],
    voters: [
      { id: 'a', name: 'Alice' },
      { id: 'b', name: 'Bob' },
      { id: 'c', name: 'Carol' },
    ],
    matches: [{ id: 9, songAId: 1, songBId: 2 }],
    ...extra,
  },
});

describe('ScenesService persisted scene and program events', () => {
  afterEach(() => jest.useRealTimers());

  it('lists and reads scenes with their layout, newest first', async () => {
    const f = fixture();
    expect(await f.service.findAll()).toEqual([f.current()]);
    expect(f.prisma.scene.findMany).toHaveBeenCalledWith({
      include: { layout: true },
      orderBy: { createdAt: 'desc' },
    });
    expect(await f.service.findOne(7)).toBe(f.current());
    expect(f.prisma.scene.findUnique).toHaveBeenCalledWith({
      where: { id: 7 },
      include: { layout: true },
    });
  });

  it('serializes scene metadata and retains explicit external-source identity', async () => {
    const f = fixture();
    const created = await f.service.create({
      name: 'New',
      layoutId: 2,
      chyronText: 'Live',
      metadata: { mode: 'live' },
      externalSourceId: 'source-1',
    });
    expect(created).toEqual({
      id: 8,
      name: 'New',
      layoutId: 2,
      chyronText: 'Live',
      metadata: '{"mode":"live"}',
      externalSourceId: 'source-1',
    });
    const empty = await f.service.create({ name: 'Blank', layoutId: 2 });
    expect(empty.metadata).toBeNull();
    expect(empty.externalSourceId).toBeNull();
  });

  it('updates assigned scenes and sends the persisted result to every affected program', async () => {
    const f = fixture();
    const result = await f.service.update(7, {
      name: 'Renamed',
      layoutId: 3,
      chyronText: 'News',
      metadata: {},
      externalSourceId: null,
    });
    expect(f.prisma.scene.update).toHaveBeenCalledWith({
      where: { id: 7 },
      data: {
        name: 'Renamed',
        layoutId: 3,
        chyronText: 'News',
        metadata: '{}',
        externalSourceId: null,
      },
      include: { layout: true },
    });
    for (const programId of ['program-a', 'program-b']) {
      expect(f.programs.broadcastUpdate).toHaveBeenCalledWith(programId, {
        type: 'scene_update',
        programId,
        scene: result,
      });
    }
    await f.service.update(7, {});
    expect(f.prisma.scene.update).toHaveBeenLastCalledWith(
      expect.objectContaining({ data: {} }),
    );
  });

  it('rejects a disappeared scene or layout before writing', async () => {
    const f = fixture();
    f.prisma.scene.findUnique.mockResolvedValueOnce(null);
    await expect(f.service.update(7, {})).rejects.toThrow('Scene not found');
    f.prisma.layout.findUnique.mockResolvedValueOnce(null);
    await expect(
      f.service.create({ name: 'Missing', layoutId: 99 }),
    ).rejects.toThrow('Layout not found');
    expect(f.prisma.scene.update).not.toHaveBeenCalled();
    expect(f.prisma.scene.create).not.toHaveBeenCalled();
  });

  it('requires a nonrevoked external identity and rejects source URLs anywhere in video metadata', async () => {
    const f = fixture();
    f.prisma.layout.findUnique.mockResolvedValue({
      componentType: 'video-stream',
    });
    await expect(
      f.service.create({ name: 'No source', layoutId: 2 }),
    ).rejects.toThrow('require externalSourceId');
    for (const metadata of [
      { sourceUrl: 'https://invalid.example' },
      { nested: [null, { sourceUrl: '' }] },
    ]) {
      await expect(
        f.service.create({
          name: 'URL',
          layoutId: 2,
          metadata,
          externalSourceId: 'source-1',
        }),
      ).rejects.toThrow('not a URL');
    }
    f.prisma.externalSource.findFirst.mockResolvedValueOnce(null);
    await expect(
      f.service.create({
        name: 'Revoked',
        layoutId: 2,
        externalSourceId: 'revoked',
      }),
    ).rejects.toThrow('External source not found');
    await f.service.create({
      name: 'Safe',
      layoutId: 2,
      metadata: { nested: [null, 'label', { sourceId: 'source-1' }] },
      externalSourceId: 'source-1',
    });
    expect(f.prisma.externalSource.findFirst).toHaveBeenLastCalledWith({
      where: { id: 'source-1', revokedAt: null },
      select: { id: true },
    });
    expect(f.prisma.scene.create).toHaveBeenCalledTimes(1);
  });

  it('preserves an existing external identity on partial updates', async () => {
    const f = fixture();
    f.current().externalSourceId = 'source-1';
    f.prisma.layout.findUnique.mockResolvedValue({
      componentType: 'video-stream',
    });
    await f.service.update(7, { name: 'Updated' });
    expect(f.prisma.externalSource.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'source-1', revokedAt: null } }),
    );
    expect(f.current().externalSourceId).toBe('source-1');
  });

  it('sends chyron changes only to active programs', async () => {
    const f = fixture();
    const scene = await f.service.updateChyron(7, 'Breaking news');
    expect(scene.chyronText).toBe('Breaking news');
    expect(f.programs.broadcastUpdate).toHaveBeenCalledTimes(1);
    expect(f.programs.broadcastUpdate).toHaveBeenCalledWith('program-a', {
      type: 'chyron_update',
      scene,
    });
  });

  it('clears active scenes before deletion and refreshes the assignments of every affected program', async () => {
    const f = fixture();
    expect((await f.service.remove(7)).id).toBe(7);
    expect(f.programs.clearActiveScene).toHaveBeenCalledWith(7);
    expect(f.prisma.scene.delete).toHaveBeenCalledWith({ where: { id: 7 } });
    expect(f.programs.broadcastUpdate).toHaveBeenCalledWith('program-a', {
      type: 'scene_cleared',
    });
    expect(f.programs.broadcastUpdate).toHaveBeenCalledWith('program-b', {
      type: 'program_scenes_changed',
      state: { programId: 'program-b', activeSceneId: null },
    });
  });

  it('runs a seeded draw without reusing assigned songs, persists one result, and announces its completion', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const f = fixture(
      bracketMetadata({
        drawDurationSeconds: 1,
        randomSongPoolIds: [1, 2, 3, 4, 4, '5', -1, null],
      }),
    );
    const started = await f.service.drawModoItalianoBracket(7, { seed: 42 });
    expect(started).toEqual({
      drawId: Date.now(),
      durationSeconds: 1,
      sceneId: 7,
    });
    const start = f.programs.broadcastUpdate.mock.calls[0][1];
    expect(new Set(start.songIds)).toEqual(new Set([3, 4, 5]));
    expect(start.type).toBe('modoitaliano_bracket_draw_start');
    await jest.advanceTimersByTimeAsync(1000);
    const saved = JSON.parse(f.current().metadata)['modoitaliano-bracket'];
    expect(saved.matches[8]).toEqual({
      id: 9,
      songAId: 1,
      songBId: 2,
      winnerId: null,
    });
    expect(saved.matches[9].songAId).toBe(start.songIds[0]);
    expect(f.programs.broadcastUpdate).toHaveBeenCalledWith(
      'program-b',
      expect.objectContaining({
        type: 'modoitaliano_bracket_draw_end',
        drawId: started.drawId,
        sceneId: 7,
      }),
    );
  });

  it('cancels an unfinished draw when the scene is edited', async () => {
    jest.useFakeTimers();
    const f = fixture(bracketMetadata({ drawDurationSeconds: 2 }));
    await f.service.drawModoItalianoBracket(7, { seed: 1 });
    await f.service.update(7, { name: 'Edited during draw' });
    await jest.advanceTimersByTimeAsync(3000);
    expect(f.prisma.scene.update).toHaveBeenCalledTimes(1);
    expect(
      f.programs.broadcastUpdate.mock.calls.map((call) => call[1].type),
    ).not.toContain('modoitaliano_bracket_draw_end');
  });

  it('replaces a previous draw timer and uses the configured fallback duration', async () => {
    jest.useFakeTimers();
    const f = fixture(bracketMetadata({ drawDurationSeconds: 0, drawSeed: 2 }));
    expect(
      (await f.service.drawModoItalianoBracket(7, { seed: NaN }))
        .durationSeconds,
    ).toBe(2);
    expect(
      (await f.service.drawModoItalianoBracket(7, { seed: 4 })).durationSeconds,
    ).toBe(2);
    await jest.advanceTimersByTimeAsync(2000);
    expect(f.prisma.scene.update).toHaveBeenCalledTimes(1);
  });

  it.each([null, 'invalid-json', '[]', 'null', '{}'])(
    'rejects draw metadata without a quarterfinal contract: %p',
    async (metadata) => {
      const f = fixture();
      f.current().metadata = metadata;
      await expect(f.service.drawModoItalianoBracket(7, {})).rejects.toThrow(
        'only available for quarterfinal',
      );
      expect(f.prisma.scene.update).not.toHaveBeenCalled();
    },
  );

  it('rejects draws with an empty pool, a full bracket, or a missing scene', async () => {
    const f = fixture(bracketMetadata({ randomSongPoolIds: null }));
    await expect(f.service.drawModoItalianoBracket(7, {})).rejects.toThrow(
      'No available songs',
    );
    f.current().metadata = JSON.stringify(
      bracketMetadata({
        matches: [9, 10, 11, 12].map((id) => ({ id, songAId: 1, songBId: 2 })),
      }),
    );
    await expect(f.service.drawModoItalianoBracket(7, {})).rejects.toThrow(
      'No available songs',
    );
    f.prisma.scene.findUnique.mockResolvedValueOnce(null);
    await expect(f.service.drawModoItalianoBracket(7, {})).rejects.toThrow(
      'Scene not found',
    );
  });

  it('ignores a draw whose scene was removed before the timer completes', async () => {
    jest.useFakeTimers();
    const f = fixture(bracketMetadata({ drawDurationSeconds: 1 }));
    await f.service.drawModoItalianoBracket(7, { seed: 1 });
    f.prisma.scene.findUnique.mockResolvedValueOnce(null);
    await jest.advanceTimersByTimeAsync(1000);
    expect(f.prisma.scene.update).not.toHaveBeenCalled();
  });

  it('opens a valid match and clears a prior voting result', async () => {
    const f = fixture(
      bracketMetadata({ votingWinnerId: 1, votingResultStartedAt: 123 }),
    );
    await f.service.openModoItalianoBracketVoting(7, {
      componentType: 'modoitaliano-bracket',
      matchId: 9,
    });
    expect(JSON.parse(f.current().metadata)['modoitaliano-bracket']).toEqual(
      expect.objectContaining({
        activeVotingMatchId: 9,
        votingWinnerId: null,
        votingResultStartedAt: null,
      }),
    );
  });

  it.each([0, 16, 1.5, NaN])(
    'rejects an invalid voting match id: %p',
    async (matchId) => {
      const f = fixture(bracketMetadata());
      await expect(
        f.service.openModoItalianoBracketVoting(7, { matchId }),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        f.service.voteModoItalianoBracket(7, {
          matchId,
          voterId: 'a',
          songId: 1,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(f.prisma.scene.update).not.toHaveBeenCalled();
    },
  );

  it('requires complete unresolved pairings before opening voting', async () => {
    const f = fixture(bracketMetadata());
    await expect(
      f.service.openModoItalianoBracketVoting(7, { matchId: 1 }),
    ).rejects.toThrow('not open for voting');
    f.current().metadata = JSON.stringify(
      bracketMetadata({
        matches: [{ id: 9, songAId: 1, songBId: 2, winnerId: 1 }],
      }),
    );
    await expect(
      f.service.openModoItalianoBracketVoting(7, { matchId: 9 }),
    ).rejects.toThrow('not open for voting');
    f.prisma.scene.findUnique.mockResolvedValueOnce(null);
    await expect(
      f.service.openModoItalianoBracketVoting(7, { matchId: 9 }),
    ).rejects.toThrow('Scene not found');
  });

  it('persists individual votes, requires a majority and advances the winning song to its actual next match', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const f = fixture(bracketMetadata());
    await f.service.voteModoItalianoBracket(7, {
      matchId: 9,
      voterId: ' a ',
      songId: 1,
    });
    let saved = JSON.parse(f.current().metadata)['modoitaliano-bracket'];
    expect(saved.matchVotes['9']).toEqual({ a: 1 });
    expect(saved.votingWinnerId).toBeNull();
    await f.service.voteModoItalianoBracket(7, {
      componentType: 'modoitaliano-bracket',
      matchId: 9,
      voterId: 'b',
      songId: 1,
    });
    saved = JSON.parse(f.current().metadata)['modoitaliano-bracket'];
    expect(saved.matches[8].winnerId).toBe(1);
    expect(saved.matches[12].songAId).toBe(1);
    expect(saved.votingWinnerId).toBe(1);
    expect(saved.votingResultStartedAt).toBe(Date.now());
  });

  it('allows withdrawing a vote without awarding a winner', async () => {
    const f = fixture(bracketMetadata({ matchVotes: { '9': { a: 1, b: 2 } } }));
    await f.service.voteModoItalianoBracket(7, {
      matchId: 9,
      voterId: 'a',
      songId: null,
    });
    const saved = JSON.parse(f.current().metadata)['modoitaliano-bracket'];
    expect(saved.matchVotes['9']).toEqual({ a: null, b: 2 });
    expect(saved.votingWinnerId).toBeNull();
  });

  it('records a final winner without inventing a later match', async () => {
    const f = fixture(
      bracketMetadata({
        voters: [{ id: 'a', name: 'Alice' }],
        matches: [
          null,
          { id: 99 },
          { id: 0 },
          { id: 1.5 },
          { id: 15, songAId: 1, songBId: 2, winnerId: 'invalid' },
        ],
      }),
    );
    await f.service.voteModoItalianoBracket(7, {
      matchId: 15,
      voterId: 'a',
      songId: 2,
    });
    const saved = JSON.parse(f.current().metadata)['modoitaliano-bracket'];
    expect(saved.matches).toHaveLength(15);
    expect(saved.matches[14].winnerId).toBe(2);
  });

  it('rejects invalid, unknown or missing voters and songs outside the pairing', async () => {
    const f = fixture(
      bracketMetadata({
        voters: [
          null,
          {},
          { id: 1, name: 'No id' },
          { id: 'a', name: 'Alice' },
        ],
      }),
    );
    await expect(
      f.service.voteModoItalianoBracket(7, {
        matchId: 9,
        voterId: ' ',
        songId: 1,
      }),
    ).rejects.toThrow('Invalid vote');
    await expect(
      f.service.voteModoItalianoBracket(7, {
        matchId: 9,
        voterId: 'missing',
        songId: 1,
      }),
    ).rejects.toThrow('Unknown voter');
    await expect(
      f.service.voteModoItalianoBracket(7, {
        matchId: 9,
        voterId: 'a',
        songId: 99,
      }),
    ).rejects.toThrow('Vote must be for a song');
    f.prisma.scene.findUnique.mockResolvedValueOnce(null);
    await expect(
      f.service.voteModoItalianoBracket(7, {
        matchId: 9,
        voterId: 'a',
        songId: 1,
      }),
    ).rejects.toThrow('Scene not found');
    expect(f.prisma.scene.update).not.toHaveBeenCalled();
  });

  describe('bracket metadata boundaries', () => {
    it('draws with an explicit component type and falls back to a five second duration when none is configured', async () => {
      jest.useFakeTimers();
      const f = fixture({
        'modoitaliano-bracket': {
          startRound: 'quarterfinals',
          randomSongPoolIds: [1, 2],
        },
      });
      const result = await f.service.drawModoItalianoBracket(7, {
        componentType: 'modoitaliano-bracket',
        seed: 1,
      });
      expect(result.durationSeconds).toBe(5);
      expect(f.programs.broadcastUpdate).toHaveBeenCalledWith(
        'program-a',
        expect.objectContaining({
          type: 'modoitaliano_bracket_draw_start',
          componentType: 'modoitaliano-bracket',
          durationSeconds: 5,
        }),
      );
      await jest.advanceTimersByTimeAsync(5000);
      const saved = JSON.parse(f.current().metadata)['modoitaliano-bracket'];
      expect(saved.matches).toHaveLength(15);
      expect(saved.matches[8].songAId).toEqual(expect.any(Number));
    });

    it('rejects votes with a non-text voter, and for scenes with no bracket or voters', async () => {
      const f = fixture(bracketMetadata());
      await expect(
        f.service.voteModoItalianoBracket(7, {
          matchId: 9,
          voterId: 5 as any,
          songId: 1,
        }),
      ).rejects.toThrow('Invalid vote');
      f.current().metadata = '{}';
      await expect(
        f.service.voteModoItalianoBracket(7, {
          matchId: 9,
          voterId: 'a',
          songId: 1,
        }),
      ).rejects.toThrow('Unknown voter');
      f.current().metadata = JSON.stringify({
        'modoitaliano-bracket': { voters: 'not-a-list' },
      });
      await expect(
        f.service.voteModoItalianoBracket(7, {
          matchId: 9,
          voterId: 'a',
          songId: 1,
        }),
      ).rejects.toThrow('Unknown voter');
      expect(f.prisma.scene.update).not.toHaveBeenCalled();
    });

    it('refuses to open voting for a scene without bracket metadata', async () => {
      const f = fixture({});
      await expect(
        f.service.openModoItalianoBracketVoting(7, { matchId: 9 }),
      ).rejects.toThrow('This match is not open for voting');
      expect(f.prisma.scene.update).not.toHaveBeenCalled();
    });

    it('completes a draw against a scene whose bracket was cleared meanwhile', async () => {
      jest.useFakeTimers();
      const f = fixture(bracketMetadata({ drawDurationSeconds: 1 }));
      await f.service.drawModoItalianoBracket(7, { seed: 1 });
      f.prisma.scene.findUnique.mockResolvedValueOnce({
        ...f.current(),
        metadata: '{}',
      });
      await jest.advanceTimersByTimeAsync(1000);
      const saved = JSON.parse(f.current().metadata)['modoitaliano-bracket'];
      expect(saved.matches[8].songAId).toEqual(expect.any(Number));
    });

    it('does not persist a completed draw when every opening slot is already filled', async () => {
      jest.useFakeTimers();
      const f = fixture(bracketMetadata({ drawDurationSeconds: 1 }));
      await f.service.drawModoItalianoBracket(7, { seed: 1 });
      f.prisma.scene.findUnique.mockResolvedValueOnce({
        ...f.current(),
        metadata: JSON.stringify(
          bracketMetadata({
            matches: [9, 10, 11, 12].map((id) => ({
              id,
              songAId: 1,
              songBId: 2,
            })),
          }),
        ),
      });
      f.programs.broadcastUpdate.mockClear();
      await jest.advanceTimersByTimeAsync(1000);
      expect(f.prisma.scene.update).not.toHaveBeenCalled();
      expect(f.programs.broadcastUpdate).not.toHaveBeenCalled();
    });

    it('ignores a draw completion that no longer matches the active draw', async () => {
      const f = fixture(bracketMetadata());
      await (f.service as any).completeModoItalianoBracketDraw(
        7,
        'modoitaliano-bracket',
        1,
        1,
      );
      expect(f.prisma.scene.findUnique).not.toHaveBeenCalled();
      expect(f.prisma.scene.update).not.toHaveBeenCalled();
    });
  });
});
