import { BadRequestException } from '@nestjs/common';
import { NO_ARTIST_LABELS } from './artist-label-lookup';
import { expandRecipe, RECIPE_STEPS } from './recipe-expand';
import { RecipesService } from './recipes.service';

// gaulatti/alcantara#424: the branches the behaviour specs do not reach on their own, for the
// backend's 100% line and branch gate.

const ROW: {
  id: number;
  programStateId: number;
  name: string;
  revision: number;
  bumperSceneId: number | null;
  slideshowSceneId: number | null;
  returnSceneId: number | null;
  transitionId: string;
  holdMs: number;
  steps: string[];
} = {
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
const SONG_WITH_SCENES = (componentType: string, programs = [1]) => ({
  name: 'scene',
  layout: { componentType },
  programScenes: programs.map((programStateId) => ({ programStateId })),
});

function setup() {
  const prisma = {
    program: { findUnique: jest.fn(async () => ({ teamId: 5 })) },
    programState: {
      findUnique: jest.fn(async () => ({ id: 1, programId: 'tv', type: 'tv' })),
    },
    rundownRecipe: {
      findFirst: jest.fn(async () => ({ ...ROW })),
      updateMany: jest.fn(async () => ({ count: 1 })),
      findUniqueOrThrow: jest.fn(async () => ({ ...ROW, revision: 3 })),
    },
    programScene: { findFirst: jest.fn(async () => ({ id: 1 })) },
    song: { findUnique: jest.fn(async () => null as unknown) },
    mediaAssetLabel: { count: jest.fn(async () => 2) },
    scene: {
      findUnique: jest.fn(async ({ where }: { where: { id: number } }) =>
        SONG_WITH_SCENES(where.id === 12 ? 'slideshow' : 'artist-bumper'),
      ),
    },
    flightSequence: { findMany: jest.fn(async () => [] as unknown[]) },
  };
  const flights = {
    listFlightSequences: jest.fn(async () => [] as unknown[]),
    updateFlightSequence: jest.fn(async () => ({ revision: 4 })),
  };
  const metrics = {
    recordRecipeExpansion: jest.fn(),
    recordRecipeRebuild: jest.fn(),
  };
  const lookup = { artistLabelFor: jest.fn(async () => null) };
  const service = new RecipesService(
    prisma as never,
    flights as never,
    metrics as never,
    lookup,
  );
  return { service, prisma, flights, metrics };
}

describe('RecipesService branches (gaulatti/alcantara#424)', () => {
  it('updates the scenes and the transition when they are given', async () => {
    const { service, prisma } = setup();
    await service.update('tv', 7, {
      revision: 2,
      bumperSceneId: 21,
      slideshowSceneId: 22,
      transitionId: 'stinger-9',
    });
    expect(prisma.rundownRecipe.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          bumperSceneId: 21,
          slideshowSceneId: 22,
          transitionId: 'stinger-9',
          revision: { increment: 1 },
        },
      }),
    );
  });

  it('asks for a label for this use when the song is unknown', async () => {
    const { service } = setup();
    const { issues } = await service.expand('tv', 7, {
      params: { songId: 404 },
    });
    expect(issues).toContainEqual({
      code: 'artist_label_missing',
      message: 'No media label for this use',
    });
  });

  it('skips the checks of a scene the recipe does not set', async () => {
    const { service, prisma } = setup();
    prisma.rundownRecipe.findFirst.mockResolvedValueOnce({
      ...ROW,
      bumperSceneId: null,
      returnSceneId: null,
    });
    await service.expand('tv', 7, { params: { songId: 404, labelId: 'l' } });
    expect(prisma.scene.findUnique).toHaveBeenCalledTimes(1);
  });

  it('refuses a program id that is not text', async () => {
    const { service } = setup();
    await expect(service.list(undefined as never)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('adds a use at the end when no position is given, and answers no use id for a recipe with no steps', async () => {
    const { service, prisma, flights } = setup();
    flights.listFlightSequences.mockResolvedValue([
      { id: 4, items: [{ id: 'a' }], scheduledAt: null, revision: 1 },
    ]);
    const added = await service.addUse('tv', 4, 7, {
      songId: 42,
      labelId: 'l',
    });
    const [, , body] = flights.updateFlightSequence.mock
      .calls[0] as unknown as [
      string,
      number,
      { items: Array<{ id: string }> },
    ];
    expect(body.items[0].id).toBe('a');
    expect(added.useId).toMatch(/^use_[0-9a-f]{12}$/);
    prisma.rundownRecipe.findFirst.mockResolvedValueOnce({ ...ROW, steps: [] });
    const empty = await service.addUse('tv', 4, 7, {
      songId: 42,
      labelId: 'l',
    });
    expect(empty).toMatchObject({ useId: '', items: [] });
  });

  it('saves nothing when every older use of a rundown is on air', async () => {
    const { service, prisma, flights, metrics } = setup();
    const items = expandRecipe(
      { ...ROW, revision: 1, steps: ['song'] },
      { id: 42, artist: 'A', title: 'T' },
      null,
      'use_aaaaaaaaaaaa',
    );
    prisma.flightSequence.findMany.mockResolvedValueOnce([
      { id: 4, items, isRunning: true, activeItemId: items[0].id, revision: 6 },
    ]);
    expect((await service.update('tv', 7, { revision: 2 })).rebuilt).toBe(0);
    expect(flights.updateFlightSequence).not.toHaveBeenCalled();
    expect(metrics.recordRecipeRebuild).toHaveBeenCalledWith('skipped');
  });
});

describe('the artist-label port before #427 binds it', () => {
  it('answers no label', async () => {
    await expect(
      NO_ARTIST_LABELS.artistLabelFor(5, 'Fictional Artist'),
    ).resolves.toBeNull();
  });
});

describe('recipe providers record Object when a collaborator is unresolved', () => {
  it.each([
    [
      './recipes.service',
      'RecipesService',
      [
        './flight.service',
        '../observability/managed-metrics.service',
        '../prisma.service',
      ],
    ],
    ['./recipes.controller', 'RecipesController', ['./recipes.service']],
    [
      '../mcp/capabilities/recipes',
      'RecipeMcpTools',
      ['./recipes.service', './flight.service'],
    ],
  ])('%s', (path, name, dependencies) => {
    jest.isolateModules(() => {
      for (const dependency of dependencies)
        jest.doMock(dependency, () => ({}));
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require(path) as Record<string, object>;
      const types = Reflect.getMetadata(
        'design:paramtypes',
        mod[name],
      ) as unknown[];
      expect(
        types.filter((type) => type === Object).length,
      ).toBeGreaterThanOrEqual(1);
    });
    for (const dependency of dependencies) jest.dontMock(dependency);
  });
});
