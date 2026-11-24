import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { ALCANTARA_PERMISSIONS } from '../../auth/permissions';
import { FlightService } from '../../program/flight.service';
import { RecipesService } from '../../program/recipes.service';
import { McpToolError, McpToolProvider, type McpToolSpec } from '../contract';
import { actionSpec, programIdArg, readSpec, rowIdArg } from './support';

const permissions = ALCANTARA_PERMISSIONS.flight;
const labelIdArg = z.string().trim().min(1).max(128).nullable().optional();
const recipeFields = {
  name: z.string().trim().min(1).max(200).optional(),
  bumper_scene_id: rowIdArg.nullable().optional(),
  slideshow_scene_id: rowIdArg.nullable().optional(),
  return_scene_id: rowIdArg.nullable().optional(),
  transition_id: z.string().trim().min(1).max(64).optional(),
  hold_ms: z.number().int().min(0).max(60_000).optional(),
  steps: z.array(z.string().max(32)).max(8).optional(),
};
type RecipeArgs = {
  [K in keyof typeof recipeFields]?: z.infer<(typeof recipeFields)[K]>;
};
const toInput = (args: RecipeArgs) => ({
  name: args.name,
  bumperSceneId: args.bumper_scene_id,
  slideshowSceneId: args.slideshow_scene_id,
  returnSceneId: args.return_scene_id,
  transitionId: args.transition_id,
  holdMs: args.hold_ms,
  steps: args.steps,
});

interface SequenceRow {
  id: number;
  name: string;
  items: Array<{ id: string }>;
  isRunning: boolean;
  activeItemId: string | null;
  scheduledAt: Date | string | null;
  revision: number;
}

/**
 * gaulatti/alcantara#424 (#222 R3): rundown recipes for MCP clients. Reads list and preview a
 * program's recipes; writes create and change them, and add one use of a recipe to an operator
 * rundown in one call (the "add a song with the song recipe" of gaulatti/alcantara#210).
 */
@Injectable()
@McpToolProvider()
export class RecipeMcpTools {
  constructor(
    private readonly recipes: RecipesService,
    private readonly flights: FlightService,
  ) {}

  specs(): McpToolSpec[] {
    return [
      readSpec({
        name: 'program_list_recipes_by_id',
        title: 'List the rundown recipes of a program',
        description:
          'Lists the rundown recipes of a program: name, revision, its bumper, slideshow and return scenes, transition, hold and enabled steps (GET /program/:programId/recipes).',
        permission: permissions.read,
        shape: { program_id: programIdArg },
        untrusted: ['name'],
        run: (args) => this.recipes.list(args.program_id),
      }),
      readSpec({
        name: 'program_expand_recipe_by_id',
        title: 'Preview one use of a rundown recipe',
        description:
          'Answers the rundown cues one use of a recipe would add for a song, and the issues that would keep it from airing as intended (song unavailable, no artist label, empty label, scene not assigned, shared or of the wrong layout). Writes nothing.',
        permission: permissions.read,
        shape: {
          program_id: programIdArg,
          recipe_id: rowIdArg,
          song_id: rowIdArg,
          label_id: labelIdArg,
        },
        run: (args) =>
          this.recipes.expand(args.program_id, args.recipe_id, {
            params: {
              songId: args.song_id,
              ...(args.label_id !== undefined
                ? { labelId: args.label_id }
                : {}),
            },
          }),
      }),
      actionSpec({
        name: 'program_create_recipe_by_id',
        title: 'Create a rundown recipe',
        description:
          'Creates a rundown recipe on a program with a television leg. Scenes must be assigned to the program. Nothing airs: a recipe is used by adding it to a rundown.',
        permission: permissions.manage,
        tier: 'W',
        shape: {
          program_id: programIdArg,
          ...recipeFields,
          name: z.string().trim().min(1).max(200),
        },
        id: (args) => args.program_id,
        plan: (args) => ({
          summary: `Creates a recipe on program ${args.program_id}. It airs only when a use of it is added to a rundown that runs.`,
          affects: [
            { kind: 'program', id: args.program_id, name: args.program_id },
          ],
          recoverable: true,
        }),
        run: (args) => this.recipes.create(args.program_id, toInput(args)),
      }),
      actionSpec({
        name: 'program_update_recipe_by_id',
        title: 'Change a rundown recipe',
        description:
          "Changes a rundown recipe; only the fields given change. Needs the `revision` you read (a stale one is refused as conflict). Uses of the recipe not yet on air in this program's rundowns are rebuilt from it; the answer says how many.",
        permission: permissions.manage,
        tier: 'W',
        shape: {
          program_id: programIdArg,
          recipe_id: rowIdArg,
          revision: z.number().int().min(1),
          ...recipeFields,
        },
        id: (args) => `${args.program_id}/${args.recipe_id}`,
        plan: (args) => ({
          summary: `Changes recipe ${args.recipe_id} on program ${args.program_id} and rebuilds its uses that are not yet on air. Cues on air or played are never touched.`,
          affects: [
            { kind: 'program', id: args.program_id, name: args.program_id },
          ],
          recoverable: true,
        }),
        run: (args) =>
          this.recipes.update(args.program_id, args.recipe_id, {
            ...toInput(args),
            revision: args.revision,
          }),
      }),
      actionSpec<
        {
          program_id: typeof programIdArg;
          sequence_id: typeof rowIdArg;
          recipe_id: typeof rowIdArg;
          song_id: typeof rowIdArg;
          label_id: typeof labelIdArg;
          position: z.ZodOptional<z.ZodNumber>;
        },
        SequenceRow
      >({
        name: 'program_add_recipe_use_by_id',
        title: 'Add a song to a rundown with a recipe',
        description:
          'Adds one use of a recipe (for example the song recipe: bumper, hold, song, slideshow for the song, back) to an operator rundown, at `position` or at the end. Refused when that position is at or before the cue on air.',
        permission: permissions.manage,
        tier: 'W',
        shape: {
          program_id: programIdArg,
          sequence_id: rowIdArg,
          recipe_id: rowIdArg,
          song_id: rowIdArg,
          label_id: labelIdArg,
          position: z.number().int().min(0).optional(),
        },
        load: async (args) => {
          const sequences = (await this.flights.listFlightSequences(
            args.program_id,
          )) as unknown as SequenceRow[];
          const sequence = sequences.find(
            (candidate) => candidate.id === args.sequence_id,
          );
          if (!sequence)
            throw new McpToolError('not_found', 'flight sequence not found');
          return sequence;
        },
        id: (args) => `${args.program_id}/${args.sequence_id}`,
        refuse: (args, sequence) => {
          if (!sequence.isRunning || !sequence.activeItemId) return null;
          const active = sequence.items.findIndex(
            (item) => item.id === sequence.activeItemId,
          );
          const at = args.position ?? sequence.items.length;
          return at <= active
            ? `position ${at} is at or before the cue on air (${active})`
            : null;
        },
        plan: (args, sequence) => ({
          summary: `Adds a use of recipe ${args.recipe_id} for song ${args.song_id} to sequence ${sequence.id} (${sequence.items.length} cue(s), revision ${sequence.revision}) at ${args.position ?? 'the end'}${sequence.isRunning ? ', after the cue on air' : ''}. Remove it by editing the rundown.`,
          affects: [
            {
              kind: 'flight_sequence',
              id: String(sequence.id),
              name: sequence.name,
            },
            { kind: 'program', id: args.program_id, name: args.program_id },
          ],
          recoverable: true,
        }),
        run: (args) =>
          this.recipes.addUse(
            args.program_id,
            args.sequence_id,
            args.recipe_id,
            {
              songId: args.song_id,
              ...(args.label_id !== undefined
                ? { labelId: args.label_id }
                : {}),
            },
            args.position,
          ),
      }),
      this.deleteSpec(),
    ];
  }

  /**
   * gaulatti/alcantara#465: deletes a recipe, tier D. The dry run names its uses per rundown; a use in a
   * running rundown is refused `on_air`. With uses left and `remove_uses` unset the service refuses
   * (`has_uses`); with it, the use cues are removed from those rundowns first.
   */
  private deleteSpec(): McpToolSpec {
    return actionSpec<
      {
        program_id: typeof programIdArg;
        recipe_id: typeof rowIdArg;
        revision: z.ZodNumber;
        remove_uses: z.ZodOptional<z.ZodBoolean>;
      },
      Awaited<ReturnType<RecipesService['usesOf']>>
    >({
      name: 'program_delete_recipe_by_id',
      title: 'Delete a rundown recipe',
      description:
        'Deletes a rundown recipe read at `revision` (a stale one is a conflict). Refused with on_air while a use of it is in a running rundown. With uses left it is refused unless `remove_uses` is true, which first removes the use cues from those rundowns. Cues already aired stay in the as-run. Not recoverable.',
      permission: permissions.manage,
      tier: 'D',
      shape: {
        program_id: programIdArg,
        recipe_id: rowIdArg,
        revision: z.number().int().min(1),
        remove_uses: z.boolean().optional(),
      },
      load: (args) => this.recipes.usesOf(args.program_id, args.recipe_id),
      id: (args) => `${args.program_id}/recipe/${args.recipe_id}`,
      label: (_args, loaded) => loaded.recipe.name,
      plan: (args, loaded) => ({
        summary: `Deletes recipe ${args.recipe_id} (revision ${loaded.recipe.revision}) of program ${args.program_id}. ${
          loaded.uses
            ? `It has ${loaded.uses} use(s) in rundown(s) ${loaded.rundowns.map((rundown) => rundown.id).join(', ')}; ${
                args.remove_uses
                  ? 'their cues are removed from those rundowns first.'
                  : 'without remove_uses the delete is refused.'
              }`
            : 'It has no uses.'
        } The recipe cannot be recovered; recreate it with program_create_recipe_by_id.`,
        affects: [
          ...loaded.rundowns.map((rundown) => ({
            kind: 'flight_sequence',
            id: String(rundown.id),
            name: rundown.name,
          })),
          { kind: 'program', id: args.program_id, name: args.program_id },
        ],
        recoverable: false,
      }),
      refuse: (_args, loaded) => {
        const running = loaded.rundowns.find((rundown) => rundown.running);
        return running
          ? `a use of this recipe is in running rundown ${running.id}`
          : null;
      },
      run: (args) =>
        this.recipes.delete(args.program_id, args.recipe_id, {
          revision: args.revision,
          removeUses: args.remove_uses === true,
        }),
    });
  }
}
