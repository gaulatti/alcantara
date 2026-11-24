import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { RECIPE_STEPS, expandRecipe } from './recipe-expand';
import { RecipesService } from './recipes.service';

const ROW = {
  id: 7,
  programStateId: 1,
  name: 'Song',
  revision: 2,
  bumperSceneId: 11,
  slideshowSceneId: 12,
  returnSceneId: 13,
  transitionId: 'cut',
  holdMs: 3000,
  steps: [...RECIPE_STEPS],
};
const SONG = {
  id: 42,
  artist: 'Fictional Artist',
  title: 'Fictional Song',
  enabled: true,
  audioUrl: 'https://media.example.test/a.mp3',
};
const scene = (componentType: string, programs = [1]) => ({
  name: `${componentType} scene`,
  layout: { componentType },
  programScenes: programs.map((programStateId) => ({ programStateId })),
});

function setup(
  over: { type?: string; label?: string | null; program?: unknown } = {},
) {
  const prisma = {
    program: {
      findUnique: jest.fn(async () =>
        'program' in over ? over.program : { teamId: 5 },
      ),
    },
    programState: {
      findUnique: jest.fn(async () => ({
        id: 1,
        programId: 'tv',
        type: over.type ?? 'tv',
      })),
    },
    rundownRecipe: {
      findMany: jest.fn(async () => [ROW]),
      findFirst: jest.fn(async () => ({ ...ROW })),
      create: jest.fn(async ({ data }: any) => ({
        id: 8,
        revision: 1,
        ...data,
      })),
      updateMany: jest.fn(async () => ({ count: 1 })),
      findUniqueOrThrow: jest.fn(async () => ({ ...ROW, revision: 3 })),
    },
    programScene: { findFirst: jest.fn(async () => ({ id: 1 })) },
    song: { findUnique: jest.fn(async () => ({ ...SONG })) },
    mediaAssetLabel: { count: jest.fn(async () => 4) },
    scene: {
      findUnique: jest.fn(
        async ({ where }: any): Promise<ReturnType<typeof scene> | null> =>
          where.id === 11
            ? scene('artist-bumper, logo')
            : where.id === 12
              ? scene('slideshow')
              : scene('full-screen', [1, 2]),
      ),
    },
    flightSequence: { findMany: jest.fn(async () => [] as any[]) },
  };
  const flights = {
    listFlightSequences: jest.fn(async () => [] as any[]),
    updateFlightSequence: jest.fn(async () => ({ revision: 9 })),
  };
  const metrics = {
    recordRecipeExpansion: jest.fn(),
    recordRecipeRebuild: jest.fn(),
  };
  const lookup = {
    artistLabelFor: jest.fn(async () =>
      over.label === undefined ? 'artist-label' : over.label,
    ),
  };
  const service = new RecipesService(
    prisma as any,
    flights as any,
    metrics as any,
    lookup,
  );
  return { service, prisma, flights, metrics, lookup };
}

describe('RecipesService (gaulatti/alcantara#424)', () => {
  it("lists a program's recipes with their steps in airing order", async () => {
    const { service, prisma } = setup();
    prisma.rundownRecipe.findMany.mockResolvedValueOnce([
      { ...ROW, steps: ['back', 'song'] },
    ]);
    expect(await service.list('tv')).toEqual([
      {
        id: 7,
        name: 'Song',
        revision: 2,
        bumperSceneId: 11,
        slideshowSceneId: 12,
        returnSceneId: 13,
        transitionId: 'cut',
        holdMs: 3000,
        steps: ['song', 'back'],
      },
    ]);
  });

  it('refuses an unknown or blank program', async () => {
    const { service, prisma } = setup();
    prisma.programState.findUnique.mockResolvedValueOnce(null as never);
    await expect(service.list('nope')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(service.list('  ')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  describe('create', () => {
    it('creates a recipe with defaults for what is not given', async () => {
      const { service, prisma } = setup();
      const recipe = await service.create('tv', {
        name: ' Song ',
        bumperSceneId: 11,
      });
      expect(prisma.rundownRecipe.create).toHaveBeenCalledWith({
        data: {
          programStateId: 1,
          name: 'Song',
          bumperSceneId: 11,
          slideshowSceneId: null,
          returnSceneId: null,
          transitionId: 'cut',
          holdMs: 3000,
          steps: [...RECIPE_STEPS],
        },
      });
      expect(recipe.steps).toEqual([...RECIPE_STEPS]);
    });

    it('keeps a transition given, trimmed', async () => {
      const { service, prisma } = setup();
      await service.create('tv', {
        name: 'Song',
        transitionId: ' stinger-1 ',
        holdMs: 0,
        steps: ['song'],
      });
      expect(prisma.rundownRecipe.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          transitionId: 'stinger-1',
          holdMs: 0,
          steps: ['song'],
        }),
      });
    });

    it.each([
      [{}, 'a recipe needs a name'],
      [{ name: '' }, 'name must be 1 to 200 characters'],
      [
        { name: 'x', bumperSceneId: 'eleven' },
        'bumperSceneId must be a scene id or null',
      ],
      [
        { name: 'x', transitionId: '' },
        'transitionId must be 1 to 64 characters',
      ],
      [
        { name: 'x', holdMs: 60_001 },
        'holdMs must be a whole number from 0 to 60000',
      ],
      [
        { name: 'x', holdMs: 1.5 },
        'holdMs must be a whole number from 0 to 60000',
      ],
      [{ name: 'x', steps: ['dance'] }, 'unknown recipe step dance'],
    ])('refuses %j', async (input, message) => {
      const { service } = setup();
      await expect(service.create('tv', input)).rejects.toThrow(message);
    });

    it('refuses a scene that is not assigned to the program, and a radio program', async () => {
      const { service, prisma } = setup();
      prisma.programScene.findFirst.mockResolvedValueOnce(null as never);
      await expect(
        service.create('tv', { name: 'x', slideshowSceneId: 99 }),
      ).rejects.toThrow('slideshowSceneId 99 is not assigned to this program');
      const radio = setup({ type: 'radio' });
      await expect(
        radio.service.create('radio', { name: 'x' }),
      ).rejects.toThrow('recipes need a program with a television leg');
    });

    it('says a duplicate name is a duplicate, and passes other errors on', async () => {
      const { service, prisma } = setup();
      prisma.rundownRecipe.create.mockRejectedValueOnce({ code: 'P2002' });
      await expect(service.create('tv', { name: 'Song' })).rejects.toThrow(
        'a recipe named "Song" already exists on this program',
      );
      prisma.rundownRecipe.create.mockRejectedValueOnce(new Error('db down'));
      await expect(service.create('tv', { name: 'Song' })).rejects.toThrow(
        'db down',
      );
    });
  });

  describe('update', () => {
    it('changes only the fields given, with the revision read', async () => {
      const { service, prisma } = setup();
      const result = await service.update('tv', 7, {
        revision: 2,
        holdMs: 0,
        returnSceneId: null,
        steps: ['song'],
      });
      expect(prisma.rundownRecipe.updateMany).toHaveBeenCalledWith({
        where: { id: 7, programStateId: 1, revision: 2 },
        data: {
          returnSceneId: null,
          holdMs: 0,
          steps: ['song'],
          revision: { increment: 1 },
        },
      });
      // The recipe as saved (what the console's editor reads), plus the count of rebuilt uses.
      expect(result).toEqual(
        expect.objectContaining({
          id: 7,
          name: 'Song',
          revision: 3,
          rebuilt: 0,
        }),
      );
    });

    it('refuses a stale revision before and during the write', async () => {
      const { service, prisma } = setup();
      await expect(
        service.update('tv', 7, { revision: 1 }),
      ).rejects.toBeInstanceOf(ConflictException);
      prisma.rundownRecipe.updateMany.mockResolvedValueOnce({ count: 0 });
      await expect(
        service.update('tv', 7, { revision: 2 }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('refuses an unknown recipe and a duplicate name', async () => {
      const { service, prisma } = setup();
      prisma.rundownRecipe.findFirst.mockResolvedValueOnce(null as never);
      await expect(
        service.update('tv', 70, { revision: 1 }),
      ).rejects.toBeInstanceOf(NotFoundException);
      prisma.rundownRecipe.updateMany.mockRejectedValueOnce({ code: 'P2002' });
      await expect(
        service.update('tv', 7, { revision: 2, name: 'Other' }),
      ).rejects.toThrow('a recipe named "Other" already exists');
    });
  });

  describe('expand', () => {
    it("builds a use with the artist's label and nothing to fix", async () => {
      const { service, metrics, lookup } = setup();
      const { items, issues } = await service.expand('tv', 7, {
        params: { songId: 42 },
        useId: 'use_0123456789ab',
      });
      expect(lookup.artistLabelFor).toHaveBeenCalledWith(5, 'Fictional Artist');
      expect(items.map((cue) => cue.id)).toEqual(
        RECIPE_STEPS.map((step) => `use_0123456789ab.${step}`),
      );
      expect(items[0].metadataPatch).toEqual({
        'artist-bumper': {
          artist: 'Fictional Artist',
          songTitle: 'Fictional Song',
          labelId: 'artist-label',
        },
      });
      expect(issues).toEqual([]);
      expect(metrics.recordRecipeExpansion).toHaveBeenCalledWith('ok');
    });

    it('looks the artist up as no team when the program row carries none (gaulatti/alcantara#464)', async () => {
      const { service, lookup } = setup({ program: null });
      await service.expand('tv', 7, { params: { songId: 42 } });
      expect(lookup.artistLabelFor).toHaveBeenCalledWith(
        null,
        'Fictional Artist',
      );
    });

    it("uses the label given for the use instead of the artist's", async () => {
      const { service, lookup } = setup();
      const { items } = await service.expand('tv', 7, {
        params: { songId: 42, labelId: 'own' },
      });
      expect(lookup.artistLabelFor).not.toHaveBeenCalled();
      expect(items[4].metadataPatch).toEqual({ slideshow: { labelId: 'own' } });
      expect(items[0].id).toMatch(/^use_[0-9a-f]{12}\.bumperPoint$/);
    });

    it('reports each issue', async () => {
      const { service, prisma, metrics } = setup({ label: null });
      prisma.song.findUnique.mockResolvedValueOnce({ ...SONG, enabled: false });
      prisma.scene.findUnique.mockImplementation(async ({ where }: any) =>
        where.id === 11
          ? scene('')
          : where.id === 12
            ? scene('slideshow', [1, 2])
            : null,
      );
      const { issues } = await service.expand('tv', 7, {
        params: { songId: 42 },
      });
      expect(issues.map((issue) => issue.code)).toEqual([
        'song_unavailable',
        'artist_label_missing',
        'scene_wrong_layout',
        'scene_shared',
        'scene_not_assigned',
      ]);
      expect(issues[2].message).toBe(
        'The bumper scene " scene" has no component',
      );
      expect(metrics.recordRecipeExpansion).toHaveBeenCalledWith('issues');
    });

    it('reports a slideshow scene without the slideshow component', async () => {
      const { service, prisma } = setup();
      prisma.scene.findUnique.mockImplementation(async ({ where }: any) =>
        where.id === 12
          ? scene('full-screen')
          : where.id === 11
            ? scene('artist-bumper')
            : scene('full-screen'),
      );
      const { issues } = await service.expand('tv', 7, {
        params: { songId: 42 },
      });
      expect(issues).toEqual([
        {
          code: 'scene_wrong_layout',
          message:
            'The slideshow scene "full-screen scene" has no slideshow component',
        },
      ]);
    });

    it('reports a missing song and an empty label', async () => {
      const { service, prisma } = setup();
      prisma.song.findUnique.mockResolvedValueOnce(null as never);
      prisma.mediaAssetLabel.count.mockResolvedValueOnce(0);
      const { issues, items } = await service.expand('tv', 7, {
        params: { songId: 404, labelId: 'empty' },
      });
      expect(issues).toEqual([
        { code: 'song_unavailable', message: 'song 404 does not exist' },
        { code: 'label_empty', message: 'The media label has no images' },
      ]);
      expect(items[3]).toMatchObject({ kind: 'playSong', songId: 404 });
    });

    it('does not ask for a label when no step uses one', async () => {
      const { service, prisma } = setup({ label: null });
      prisma.rundownRecipe.findFirst.mockResolvedValueOnce({
        ...ROW,
        steps: ['song', 'songEnd'],
      });
      const { issues } = await service.expand('tv', 7, {
        params: { songId: 42 },
      });
      expect(issues.map((issue) => issue.code)).not.toContain(
        'artist_label_missing',
      );
    });

    it.each([
      [{ params: {} }, 'params.songId must be a song id'],
      [
        { params: { songId: 42, labelId: 5 } },
        'params.labelId must be a label id or null',
      ],
      [{ params: { songId: 42 }, useId: 'mine' }, 'useId must look like use_'],
    ])('refuses %j and counts it', async (body, message) => {
      const { service, metrics } = setup();
      await expect(service.expand('tv', 7, body as any)).rejects.toThrow(
        message,
      );
      expect(metrics.recordRecipeExpansion).toHaveBeenCalledWith('rejected');
    });
  });

  describe('rebuild after a recipe change', () => {
    const tagged = (useId: string, revision: number) =>
      expandRecipe(
        { ...ROW, revision, steps: ['song', 'songEnd'] } as any,
        { id: 42, artist: 'A', title: 'T' },
        null,
        useId,
      );

    it('rebuilds older uses after the cue on air, leaves the one on air, and keeps hand cues', async () => {
      const { service, prisma, flights, metrics } = setup();
      const onAir = tagged('use_aaaaaaaaaaaa', 1);
      const later = tagged('use_bbbbbbbbbbbb', 1);
      const current = tagged('use_cccccccccccc', 3);
      const items = [
        ...onAir,
        { id: 'hand', kind: 'wait', durationMs: 5 },
        ...later,
        ...current,
      ];
      prisma.flightSequence.findMany.mockResolvedValueOnce([
        {
          id: 4,
          items,
          isRunning: true,
          activeItemId: onAir[0].id,
          revision: 6,
        },
        {
          id: 5,
          items: [{ id: 'x', kind: 'wait' }],
          isRunning: false,
          activeItemId: null,
          revision: 1,
        },
      ]);
      const { rebuilt } = await service.update('tv', 7, { revision: 2 });
      expect(rebuilt).toBe(1);
      const [, sequenceId, { items: next, revision }] = flights
        .updateFlightSequence.mock.calls[0] as any;
      expect([sequenceId, revision]).toEqual([4, 6]);
      expect(next.slice(0, 3)).toEqual(items.slice(0, 3));
      expect(next.slice(3).map((cue: any) => cue.id)).toEqual([
        ...RECIPE_STEPS.map((step) => `use_bbbbbbbbbbbb.${step}`),
        ...current.map((cue) => cue.id),
      ]);
      expect(next[3].recipeUse.recipeRevision).toBe(3);
      expect(metrics.recordRecipeRebuild.mock.calls).toEqual([
        ['skipped'],
        ['rebuilt'],
      ]);
      expect(prisma.flightSequence.findMany).toHaveBeenCalledWith({
        where: { programStateId: 1, scheduledAt: null },
      });
    });

    it('counts a concurrent rundown edit as a conflict and passes other failures on', async () => {
      const { service, prisma, flights, metrics } = setup();
      prisma.flightSequence.findMany.mockResolvedValue([
        {
          id: 4,
          items: tagged('use_bbbbbbbbbbbb', 1),
          isRunning: false,
          activeItemId: null,
          revision: 6,
        },
      ]);
      flights.updateFlightSequence.mockRejectedValueOnce(
        new ConflictException('changed'),
      );
      expect((await service.update('tv', 7, { revision: 2 })).rebuilt).toBe(0);
      expect(metrics.recordRecipeRebuild).toHaveBeenCalledWith('conflict');
      flights.updateFlightSequence.mockRejectedValueOnce(new Error('db down'));
      await expect(service.update('tv', 7, { revision: 2 })).rejects.toThrow(
        'db down',
      );
    });

    it('treats a sequence with items that are not a list as having no uses', async () => {
      const { service, prisma, flights } = setup();
      prisma.flightSequence.findMany.mockResolvedValueOnce([
        {
          id: 4,
          items: null,
          isRunning: false,
          activeItemId: null,
          revision: 1,
        },
      ]);
      expect((await service.update('tv', 7, { revision: 2 })).rebuilt).toBe(0);
      expect(flights.updateFlightSequence).not.toHaveBeenCalled();
    });
  });

  describe('addUse (MCP)', () => {
    it('inserts the use at the position given, through the rundown update', async () => {
      const { service, flights } = setup();
      flights.listFlightSequences.mockResolvedValueOnce([
        {
          id: 4,
          items: [{ id: 'a' }, { id: 'b' }],
          scheduledAt: null,
          revision: 6,
        },
      ]);
      const result = await service.addUse('tv', 4, 7, { songId: 42 }, 1);
      const [, , { items, revision }] = flights.updateFlightSequence.mock
        .calls[0] as any;
      expect(revision).toBe(6);
      expect(items.map((cue: any) => cue.id)).toEqual([
        'a',
        ...result.items.map((cue) => cue.id),
        'b',
      ]);
      expect(result.useId).toMatch(/^use_[0-9a-f]{12}$/);
      expect(result.revision).toBe(9);
    });

    it('appends by default, and refuses an unknown or clocked sequence', async () => {
      const { service, flights } = setup();
      flights.listFlightSequences.mockResolvedValueOnce([
        { id: 4, items: [{ id: 'a' }], scheduledAt: null, revision: 1 },
      ]);
      await service.addUse('tv', 4, 7, { songId: 42, labelId: 'own' }, 99);
      expect(
        (flights.updateFlightSequence.mock.calls[0] as any)[2].items[0].id,
      ).toBe('a');
      flights.listFlightSequences.mockResolvedValueOnce([]);
      await expect(
        service.addUse('tv', 4, 7, { songId: 42 }),
      ).rejects.toBeInstanceOf(NotFoundException);
      flights.listFlightSequences.mockResolvedValueOnce([
        { id: 4, items: [], scheduledAt: '2026-11-24T10:00:00Z', revision: 1 },
      ]);
      await expect(service.addUse('tv', 4, 7, { songId: 42 })).rejects.toThrow(
        'recipes are for operator rundowns',
      );
    });
  });
});
