import { ConflictException, NotFoundException } from '@nestjs/common';
import { ALCANTARA_PERMISSIONS } from '../auth/permissions';
import { REQUIRED_PERMISSION_KEY } from '../auth/require-permission.decorator';
import { RecipeMcpTools } from '../mcp/capabilities/recipes';
import { RecipesController } from './recipes.controller';
import { RecipesService } from './recipes.service';

// gaulatti/alcantara#465: deleting a recipe, through the service, the API route and MCP.

const ROW = {
  id: 7,
  programStateId: 1,
  name: 'Song',
  revision: 3,
  bumperSceneId: 11,
  slideshowSceneId: null,
  returnSceneId: null,
  transitionId: 'cut',
  holdMs: 0,
  steps: ['song'],
};
const tagged = (useId: string, recipeId = 7) => ({
  id: `${useId}.song`,
  kind: 'playSong',
  songId: 42,
  recipeUse: {
    useId,
    recipeId,
    recipeRevision: 3,
    step: 'song',
    params: { songId: 42 },
  },
});
type Sequence = {
  id: number;
  name: string;
  items: unknown;
  isRunning: boolean;
  revision: number;
};

function setup(sequences: Sequence[] = []) {
  const prisma = {
    programState: {
      findUnique: jest.fn(() =>
        Promise.resolve({ id: 1, programId: 'tv', type: 'tv' }),
      ),
    },
    rundownRecipe: {
      findFirst: jest.fn(
        (): Promise<typeof ROW | null> => Promise.resolve({ ...ROW }),
      ),
      deleteMany: jest.fn(async () => ({ count: 1 })),
    },
    flightSequence: {
      findMany: jest.fn(async () => sequences),
      findFirstOrThrow: jest.fn(
        async ({ where }: { where: { id: number } }) =>
          sequences.find((s) => s.id === where.id)!,
      ),
    },
  };
  const flights = {
    updateFlightSequence: jest.fn(async () => ({ revision: 9 })),
  };
  const metrics = { recordRecipeDelete: jest.fn() };
  const service = new RecipesService(
    prisma as never,
    flights as never,
    metrics as never,
    {
      artistLabelFor: async () => null,
    },
  );
  return { service, prisma, flights, metrics };
}

describe('RecipesService.delete (gaulatti/alcantara#465)', () => {
  it('deletes a recipe with no uses, compare-and-set on its revision', async () => {
    const { service, prisma, metrics } = setup([
      {
        id: 4,
        name: 'Hand',
        items: [{ id: 'a', kind: 'wait' }],
        isRunning: false,
        revision: 1,
      },
    ]);
    expect(await service.delete('tv', 7, { revision: 3 })).toEqual({
      deleted: 7,
      removedUses: 0,
    });
    expect(prisma.rundownRecipe.deleteMany).toHaveBeenCalledWith({
      where: { id: 7, programStateId: 1, revision: 3 },
    });
    expect(metrics.recordRecipeDelete).toHaveBeenCalledWith('deleted');
  });

  it('counts the uses per rundown, ignoring other recipes and untagged cues', async () => {
    const { service } = setup([
      {
        id: 4,
        name: 'Evening',
        items: [
          tagged('use_aaaaaaaaaaaa'),
          tagged('use_aaaaaaaaaaaa'),
          tagged('use_bbbbbbbbbbbb'),
        ],
        isRunning: false,
        revision: 2,
      },
      {
        id: 5,
        name: 'Other',
        items: [tagged('use_cccccccccccc', 8), null],
        isRunning: false,
        revision: 1,
      },
      { id: 6, name: 'Broken', items: null, isRunning: false, revision: 1 },
    ]);
    const uses = await service.usesOf('tv', 7);
    expect(uses.uses).toBe(2);
    expect(uses.rundowns).toEqual([
      { id: 4, name: 'Evening', uses: 2, running: false, revision: 2 },
    ]);
  });

  it('refuses a stale revision, before and during the delete', async () => {
    const { service, prisma, metrics } = setup();
    await expect(
      service.delete('tv', 7, { revision: 2 }),
    ).rejects.toBeInstanceOf(ConflictException);
    prisma.rundownRecipe.deleteMany.mockResolvedValueOnce({ count: 0 });
    await expect(
      service.delete('tv', 7, { revision: 3 }),
    ).rejects.toMatchObject({
      response: { code: 'conflict', statusCode: 409 },
    });
    expect(metrics.recordRecipeDelete.mock.calls).toEqual([
      ['conflict'],
      ['conflict'],
    ]);
  });

  it('refuses on_air while a use is in a running rundown', async () => {
    const { service, prisma, metrics } = setup([
      {
        id: 4,
        name: 'Live',
        items: [tagged('use_aaaaaaaaaaaa')],
        isRunning: true,
        revision: 2,
      },
    ]);
    await expect(
      service.delete('tv', 7, { revision: 3, removeUses: true }),
    ).rejects.toMatchObject({
      response: { code: 'on_air' },
    });
    expect(prisma.rundownRecipe.deleteMany).not.toHaveBeenCalled();
    expect(metrics.recordRecipeDelete).toHaveBeenCalledWith('refused_on_air');
  });

  it('refuses has_uses with the count unless removeUses', async () => {
    const { service, metrics } = setup([
      {
        id: 4,
        name: 'Evening',
        items: [tagged('use_aaaaaaaaaaaa')],
        isRunning: false,
        revision: 2,
      },
    ]);
    await expect(
      service.delete('tv', 7, { revision: 3 }),
    ).rejects.toMatchObject({
      response: { code: 'has_uses', uses: 1 },
    });
    expect(metrics.recordRecipeDelete).toHaveBeenCalledWith('refused_has_uses');
  });

  it('removes the use cues from their rundowns first with removeUses, then deletes', async () => {
    const items = [
      { id: 'hand', kind: 'wait' },
      tagged('use_aaaaaaaaaaaa'),
      tagged('use_cccccccccccc', 8),
    ];
    const { service, flights } = setup([
      { id: 4, name: 'Evening', items, isRunning: false, revision: 2 },
    ]);
    expect(
      await service.delete('tv', 7, { revision: 3, removeUses: true }),
    ).toEqual({ deleted: 7, removedUses: 1 });
    expect(flights.updateFlightSequence).toHaveBeenCalledWith('tv', 4, {
      items: [items[0], items[2]],
      revision: 2,
    });
  });

  it('counts a rundown edited at the same moment as a conflict, and passes other failures on', async () => {
    const sequences = [
      {
        id: 4,
        name: 'Evening',
        items: [tagged('use_aaaaaaaaaaaa')],
        isRunning: false,
        revision: 2,
      },
    ];
    const { service, flights, metrics } = setup(sequences);
    flights.updateFlightSequence.mockRejectedValueOnce(
      new ConflictException('changed'),
    );
    await expect(
      service.delete('tv', 7, { revision: 3, removeUses: true }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(metrics.recordRecipeDelete).toHaveBeenCalledWith('conflict');
    flights.updateFlightSequence.mockRejectedValueOnce(new Error('db down'));
    await expect(
      service.delete('tv', 7, { revision: 3, removeUses: true }),
    ).rejects.toThrow('db down');
  });

  it('treats a rundown whose items are not a list as empty when removing uses', async () => {
    const sequences = [
      {
        id: 4,
        name: 'Evening',
        items: [tagged('use_aaaaaaaaaaaa')],
        isRunning: false,
        revision: 2,
      },
    ];
    const { service, prisma, flights } = setup(sequences);
    prisma.flightSequence.findFirstOrThrow.mockResolvedValueOnce({
      ...sequences[0],
      items: null,
    });
    await service.delete('tv', 7, { revision: 3, removeUses: true });
    expect(flights.updateFlightSequence).toHaveBeenCalledWith('tv', 4, {
      items: [],
      revision: 2,
    });
  });

  it('answers 404 for an unknown recipe', async () => {
    const { service, prisma } = setup();
    prisma.rundownRecipe.findFirst.mockResolvedValueOnce(null);
    await expect(
      service.delete('tv', 70, { revision: 1 }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('DELETE /program/:programId/recipes/:recipeId', () => {
  it('hands the revision and removeUses to the service, with flight.manage', async () => {
    const recipes = {
      delete: jest.fn(async () => ({ deleted: 7, removedUses: 0 })),
    };
    const controller = new RecipesController(recipes as never);
    await controller.deleteRecipe('tv', 7, 3, true);
    expect(recipes.delete).toHaveBeenCalledWith('tv', 7, {
      revision: 3,
      removeUses: true,
    });
    await controller.deleteRecipe('tv', 7, 3, undefined);
    expect(recipes.delete).toHaveBeenLastCalledWith('tv', 7, {
      revision: 3,
      removeUses: false,
    });
    expect(
      Reflect.getMetadata(
        REQUIRED_PERMISSION_KEY,
        RecipesController.prototype.deleteRecipe,
      ),
    ).toBe(ALCANTARA_PERMISSIONS.flight.manage);
  });
});

describe('program_delete_recipe_by_id', () => {
  const usesOf = (
    rundowns: Array<{
      id: number;
      name: string;
      uses: number;
      running: boolean;
      revision: number;
    }>,
  ) => ({
    recipe: { ...ROW, steps: ['song'] },
    uses: rundowns.reduce((sum, rundown) => sum + rundown.uses, 0),
    rundowns,
  });
  const recipes = {
    usesOf: jest.fn(),
    delete: jest.fn(async () => ({ deleted: 7, removedUses: 1 })),
  };
  const spec = new RecipeMcpTools(recipes as never, {} as never, {} as never)
    .specs()
    .find((s) => s.name === 'program_delete_recipe_by_id')!;
  const ctx = {} as never;

  it('is a tier D capability with flight.manage', () => {
    expect([spec.tier, spec.permission]).toEqual([
      'D',
      ALCANTARA_PERMISSIONS.flight.manage,
    ]);
  });

  it('plans in words: uses per rundown, with and without remove_uses, or none', async () => {
    recipes.usesOf.mockResolvedValue(
      usesOf([{ id: 12, name: 'e2e', uses: 1, running: false, revision: 4 }]),
    );
    const refused = await spec.dryRun!(
      { program_id: 'tv', recipe_id: 7, revision: 3 },
      ctx,
    );
    expect(refused.summary).toContain(
      'It has 1 use(s) in rundown(s) 12; without remove_uses the delete is refused.',
    );
    expect(refused.affects).toContainEqual({
      kind: 'flight_sequence',
      id: '12',
      name: 'e2e',
    });
    const removing = await spec.dryRun!(
      { program_id: 'tv', recipe_id: 7, revision: 3, remove_uses: true },
      ctx,
    );
    expect(removing.summary).toContain(
      'their cues are removed from those rundowns first.',
    );
    recipes.usesOf.mockResolvedValue(usesOf([]));
    expect(
      (await spec.dryRun!({ program_id: 'tv', recipe_id: 7, revision: 3 }, ctx))
        .summary,
    ).toContain('It has no uses.');
  });

  it('refuses on_air while a use is in a running rundown, and deletes otherwise', async () => {
    recipes.usesOf.mockResolvedValue(
      usesOf([{ id: 12, name: 'e2e', uses: 1, running: true, revision: 4 }]),
    );
    await expect(
      spec.run({ program_id: 'tv', recipe_id: 7, revision: 3 }, ctx),
    ).rejects.toMatchObject({ code: 'on_air' });
    recipes.usesOf.mockResolvedValue(
      usesOf([{ id: 12, name: 'e2e', uses: 1, running: false, revision: 4 }]),
    );
    await spec.run(
      { program_id: 'tv', recipe_id: 7, revision: 3, remove_uses: true },
      ctx,
    );
    expect(recipes.delete).toHaveBeenCalledWith('tv', 7, {
      revision: 3,
      removeUses: true,
    });
    await spec.run({ program_id: 'tv', recipe_id: 7, revision: 3 }, ctx);
    expect(recipes.delete).toHaveBeenLastCalledWith('tv', 7, {
      revision: 3,
      removeUses: false,
    });
  });
});
