import { ALCANTARA_PERMISSIONS } from '../../auth/permissions';
import { RecipeMcpTools } from './recipes';

const recipes = {
  list: jest.fn(async () => []),
  expand: jest.fn(async () => ({ items: [], issues: [] })),
  create: jest.fn(async () => ({ id: 8 })),
  update: jest.fn(async () => ({ rebuilt: 0 })),
  addUse: jest.fn(async () => ({ useId: 'use_0123456789ab' })),
};
const flights = { listFlightSequences: jest.fn() };
const tools = new RecipeMcpTools(recipes as any, flights as any);
const spec = (name: string) =>
  tools.specs().find((candidate) => candidate.name === name)!;
const ctx = {} as any;

describe('recipe capabilities (gaulatti/alcantara#424)', () => {
  it('registers two reads, three writes and one delete with the flight permissions', () => {
    expect(tools.specs().map((s) => [s.name, s.tier, s.permission])).toEqual([
      ['program_list_recipes_by_id', 'R', ALCANTARA_PERMISSIONS.flight.read],
      ['program_expand_recipe_by_id', 'R', ALCANTARA_PERMISSIONS.flight.read],
      ['program_create_recipe_by_id', 'W', ALCANTARA_PERMISSIONS.flight.manage],
      ['program_update_recipe_by_id', 'W', ALCANTARA_PERMISSIONS.flight.manage],
      [
        'program_add_recipe_use_by_id',
        'W',
        ALCANTARA_PERMISSIONS.flight.manage,
      ],
      ['program_delete_recipe_by_id', 'D', ALCANTARA_PERMISSIONS.flight.manage],
    ]);
  });

  it('reads and previews through the service', async () => {
    await spec('program_list_recipes_by_id').run({ program_id: 'tv' }, ctx);
    expect(recipes.list).toHaveBeenCalledWith('tv');
    await spec('program_expand_recipe_by_id').run(
      { program_id: 'tv', recipe_id: 7, song_id: 42 },
      ctx,
    );
    expect(recipes.expand).toHaveBeenLastCalledWith('tv', 7, {
      params: { songId: 42 },
    });
    await spec('program_expand_recipe_by_id').run(
      { program_id: 'tv', recipe_id: 7, song_id: 42, label_id: null },
      ctx,
    );
    expect(recipes.expand).toHaveBeenLastCalledWith('tv', 7, {
      params: { songId: 42, labelId: null },
    });
  });

  it("creates and updates with the console's field names", async () => {
    await spec('program_create_recipe_by_id').run(
      { program_id: 'tv', name: 'Song', hold_ms: 0, bumper_scene_id: 11 },
      ctx,
    );
    expect(recipes.create).toHaveBeenCalledWith(
      'tv',
      expect.objectContaining({ name: 'Song', holdMs: 0, bumperSceneId: 11 }),
    );
    await spec('program_update_recipe_by_id').run(
      { program_id: 'tv', recipe_id: 7, revision: 2, steps: ['song'] },
      ctx,
    );
    expect(recipes.update).toHaveBeenCalledWith(
      'tv',
      7,
      expect.objectContaining({ revision: 2, steps: ['song'] }),
    );
    const created = await spec('program_create_recipe_by_id').dryRun!(
      { program_id: 'tv', name: 'Song' },
      ctx,
    );
    expect(created.summary).toContain('Creates a recipe on program tv');
    const updated = await spec('program_update_recipe_by_id').dryRun!(
      { program_id: 'tv', recipe_id: 7, revision: 2 },
      ctx,
    );
    expect(updated.summary).toContain(
      'rebuilds its uses that are not yet on air',
    );
  });

  describe('program_add_recipe_use_by_id', () => {
    const sequence = (over: object = {}) => ({
      id: 4,
      name: 'Morning',
      items: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
      isRunning: true,
      activeItemId: 'b',
      scheduledAt: null,
      revision: 6,
      ...over,
    });

    it('adds after the cue on air, and plans it in words', async () => {
      flights.listFlightSequences.mockResolvedValue([sequence()]);
      const args = {
        program_id: 'tv',
        sequence_id: 4,
        recipe_id: 7,
        song_id: 42,
        position: 2,
      };
      const plan = await spec('program_add_recipe_use_by_id').dryRun!(
        args,
        ctx,
      );
      expect(plan.summary).toContain(
        'to sequence 4 (3 cue(s), revision 6) at 2, after the cue on air',
      );
      await spec('program_add_recipe_use_by_id').run(args, ctx);
      expect(recipes.addUse).toHaveBeenCalledWith(
        'tv',
        4,
        7,
        { songId: 42 },
        2,
      );
      await spec('program_add_recipe_use_by_id').run(
        { ...args, label_id: 'own', position: undefined },
        ctx,
      );
      expect(recipes.addUse).toHaveBeenLastCalledWith(
        'tv',
        4,
        7,
        { songId: 42, labelId: 'own' },
        undefined,
      );
    });

    it('refuses a position at or before the cue on air, and an unknown sequence', async () => {
      flights.listFlightSequences.mockResolvedValue([sequence()]);
      await expect(
        spec('program_add_recipe_use_by_id').run(
          {
            program_id: 'tv',
            sequence_id: 4,
            recipe_id: 7,
            song_id: 42,
            position: 1,
          },
          ctx,
        ),
      ).rejects.toMatchObject({ code: 'on_air' });
      flights.listFlightSequences.mockResolvedValue([
        sequence({ isRunning: false }),
      ]);
      const idle = await spec('program_add_recipe_use_by_id').dryRun!(
        { program_id: 'tv', sequence_id: 4, recipe_id: 7, song_id: 42 },
        ctx,
      );
      expect(idle.summary).toContain('at the end');
      flights.listFlightSequences.mockResolvedValue([]);
      await expect(
        spec('program_add_recipe_use_by_id').run(
          { program_id: 'tv', sequence_id: 4, recipe_id: 7, song_id: 42 },
          ctx,
        ),
      ).rejects.toMatchObject({ code: 'not_found' });
    });
  });
});
