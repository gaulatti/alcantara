import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ManagedMetricsService } from '../observability/managed-metrics.service';
import { PrismaService } from '../prisma.service';
import {
  ARTIST_LABEL_LOOKUP,
  type ArtistLabelLookup,
} from './artist-label-lookup';
import { FlightService } from './flight.service';
import type { FlightCue } from './flight.types';
import {
  MAX_HOLD_MS,
  RECIPE_STEPS,
  SLIDESHOW_COMPONENT,
  expandRecipe,
  firstComponent,
  findRecipeUses,
  isUseId,
  newUseId,
  normalizeRecipeSteps,
  stepsUsingLabel,
  type RecipeDefinition,
  type RecipeStep,
} from './recipe-expand';

/** The fields a recipe is created or updated with (contract C3, gaulatti/alcantara#222). */
export interface RecipeInput {
  name?: unknown;
  bumperSceneId?: unknown;
  slideshowSceneId?: unknown;
  returnSceneId?: unknown;
  transitionId?: unknown;
  holdMs?: unknown;
  steps?: unknown;
  revision?: unknown;
}

export interface RecipeView {
  id: number;
  name: string;
  revision: number;
  bumperSceneId: number | null;
  slideshowSceneId: number | null;
  returnSceneId: number | null;
  transitionId: string;
  holdMs: number;
  steps: RecipeStep[];
}

export type RecipeIssueCode =
  | 'song_unavailable'
  | 'artist_label_missing'
  | 'label_empty'
  | 'scene_not_assigned'
  | 'scene_shared'
  | 'scene_wrong_layout';

export interface RecipeIssue {
  code: RecipeIssueCode;
  message: string;
}

interface RecipeRow {
  id: number;
  name: string;
  revision: number;
  bumperSceneId: number | null;
  slideshowSceneId: number | null;
  returnSceneId: number | null;
  transitionId: string;
  holdMs: number;
  steps: unknown;
}

function toView(row: RecipeRow): RecipeView {
  return {
    id: row.id,
    name: row.name,
    revision: row.revision,
    bumperSceneId: row.bumperSceneId,
    slideshowSceneId: row.slideshowSceneId,
    returnSceneId: row.returnSceneId,
    transitionId: row.transitionId,
    holdMs: row.holdMs,
    steps: normalizeRecipeSteps(row.steps),
  };
}

function definition(row: RecipeView): RecipeDefinition {
  return { ...row };
}

/** A scene id, or null to clear it. Anything else is a 400. */
function sceneIdOf(value: unknown, field: string): number | null {
  if (value === null) return null;
  if (Number.isInteger(value) && (value as number) > 0) return value as number;
  throw new BadRequestException(`${field} must be a scene id or null`);
}

@Injectable()
export class RecipesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly flights: FlightService,
    private readonly metrics: ManagedMetricsService,
    @Inject(ARTIST_LABEL_LOOKUP)
    private readonly artistLabels: ArtistLabelLookup,
  ) {}

  async list(programId: string): Promise<RecipeView[]> {
    const state = await this.program(programId);
    const rows = await this.prisma.rundownRecipe.findMany({
      where: { programStateId: state.id },
      orderBy: { id: 'asc' },
    });
    return rows.map(toView);
  }

  async create(programId: string, input: RecipeInput): Promise<RecipeView> {
    const state = await this.program(programId, true);
    const fields = await this.fields(state.id, input);
    if (fields.name === undefined)
      throw new BadRequestException('a recipe needs a name');
    try {
      const row = await this.prisma.rundownRecipe.create({
        data: {
          programStateId: state.id,
          name: fields.name,
          bumperSceneId: fields.bumperSceneId ?? null,
          slideshowSceneId: fields.slideshowSceneId ?? null,
          returnSceneId: fields.returnSceneId ?? null,
          transitionId: fields.transitionId ?? 'cut',
          holdMs: fields.holdMs ?? 3000,
          steps: fields.steps ?? [...RECIPE_STEPS],
        },
      });
      return toView(row);
    } catch (error) {
      throw this.duplicate(error, fields.name);
    }
  }

  /**
   * Changes a recipe when `revision` is the one stored (409 otherwise), then rebuilds the uses of
   * it that are not yet on air in this program's rundowns.
   */
  async update(
    programId: string,
    recipeId: number,
    input: RecipeInput,
  ): Promise<RecipeView & { rebuilt: number }> {
    const state = await this.program(programId, true);
    const existing = await this.recipe(state.id, recipeId);
    if (input.revision !== existing.revision)
      throw new ConflictException('The recipe changed. Reload before saving.');
    const fields = await this.fields(state.id, input);
    let row: RecipeRow;
    try {
      const result = await this.prisma.rundownRecipe.updateMany({
        where: {
          id: recipeId,
          programStateId: state.id,
          revision: existing.revision,
        },
        data: {
          ...(fields.name !== undefined ? { name: fields.name } : {}),
          ...(fields.bumperSceneId !== undefined
            ? { bumperSceneId: fields.bumperSceneId }
            : {}),
          ...(fields.slideshowSceneId !== undefined
            ? { slideshowSceneId: fields.slideshowSceneId }
            : {}),
          ...(fields.returnSceneId !== undefined
            ? { returnSceneId: fields.returnSceneId }
            : {}),
          ...(fields.transitionId !== undefined
            ? { transitionId: fields.transitionId }
            : {}),
          ...(fields.holdMs !== undefined ? { holdMs: fields.holdMs } : {}),
          ...(fields.steps !== undefined ? { steps: fields.steps } : {}),
          revision: { increment: 1 },
        },
      });
      if (result.count !== 1)
        throw new ConflictException(
          'The recipe changed. Reload before saving.',
        );
      row = await this.prisma.rundownRecipe.findUniqueOrThrow({
        where: { id: recipeId },
      });
    } catch (error) {
      throw this.duplicate(error, fields.name ?? existing.name);
    }
    const recipe = toView(row);
    const rebuilt = await this.rebuild(programId, state.id, recipe);
    // The recipe as saved, plus how many uses followed it (the console reads the recipe fields).
    return { ...recipe, rebuilt };
  }

  /**
   * The cues of one use of a recipe, and what would keep it from airing as intended. A preview:
   * nothing is written. `useId` keeps a use's ids when it is built again.
   */
  async expand(
    programId: string,
    recipeId: number,
    body: { params?: { songId?: unknown; labelId?: unknown }; useId?: unknown },
  ): Promise<{ items: FlightCue[]; issues: RecipeIssue[] }> {
    try {
      const state = await this.program(programId, true);
      const recipe = toView(await this.recipe(state.id, recipeId));
      const songId = body?.params?.songId;
      if (!Number.isInteger(songId) || (songId as number) <= 0)
        throw new BadRequestException('params.songId must be a song id');
      const labelParam = body?.params?.labelId;
      if (
        labelParam !== undefined &&
        labelParam !== null &&
        typeof labelParam !== 'string'
      )
        throw new BadRequestException(
          'params.labelId must be a label id or null',
        );
      if (body?.useId !== undefined && !isUseId(body.useId))
        throw new BadRequestException(
          'useId must look like use_ followed by 12 hex characters',
        );
      const useId = body?.useId ?? newUseId();
      const result = await this.build(
        state.programId,
        state.id,
        recipe,
        songId as number,
        labelParam ?? undefined,
        useId,
      );
      this.metrics.recordRecipeExpansion(
        result.issues.length ? 'issues' : 'ok',
      );
      return result;
    } catch (error) {
      this.metrics.recordRecipeExpansion('rejected');
      throw error;
    }
  }

  /**
   * MCP `program_add_recipe_use_by_id`: expands one use and inserts it into an operator rundown at
   * `position` (default: the end), through the rundown's normal update path, which refuses any change
   * to cues already on air or played.
   */
  async addUse(
    programId: string,
    sequenceId: number,
    recipeId: number,
    params: { songId: number; labelId?: string | null },
    position?: number,
  ): Promise<{
    useId: string;
    items: FlightCue[];
    issues: RecipeIssue[];
    revision: number;
  }> {
    const { items, issues } = await this.expand(programId, recipeId, {
      params,
    });
    const sequences = await this.flights.listFlightSequences(programId);
    const sequence = sequences.find((candidate) => candidate.id === sequenceId);
    if (!sequence) throw new NotFoundException('flight sequence not found');
    if (sequence.scheduledAt)
      throw new BadRequestException(
        'recipes are for operator rundowns, not clocked radio logs',
      );
    const at =
      position === undefined
        ? sequence.items.length
        : Math.max(0, Math.min(position, sequence.items.length));
    const next = [
      ...sequence.items.slice(0, at),
      ...items,
      ...sequence.items.slice(at),
    ];
    const saved = await this.flights.updateFlightSequence(
      programId,
      sequenceId,
      {
        items: next,
        revision: sequence.revision,
      },
    );
    const tag = (
      items[0] as (FlightCue & { recipeUse?: { useId: string } }) | undefined
    )?.recipeUse;
    return { useId: tag?.useId ?? '', items, issues, revision: saved.revision };
  }

  private async build(
    programId: string,
    programStateId: number,
    recipe: RecipeView,
    songId: number,
    labelParam: string | null | undefined,
    useId: string,
  ): Promise<{ items: FlightCue[]; issues: RecipeIssue[] }> {
    const issues: RecipeIssue[] = [];
    const song = await this.prisma.song.findUnique({
      where: { id: songId },
      select: {
        id: true,
        artist: true,
        title: true,
        enabled: true,
        audioUrl: true,
      },
    });
    if (!song || !song.enabled || !song.audioUrl?.trim())
      issues.push({
        code: 'song_unavailable',
        message: song
          ? `"${song.title}" is disabled or has no audio`
          : `song ${songId} does not exist`,
      });
    let labelId: string | null = labelParam ?? null;
    if (labelParam === undefined && song)
      labelId = await this.artistLabels.artistLabelFor(
        await this.programTeam(programId),
        song.artist,
      );
    if (stepsUsingLabel(recipe.steps)) {
      if (!labelId)
        issues.push({
          code: 'artist_label_missing',
          message: song
            ? `No media label for ${song.artist}; name one for this use`
            : 'No media label for this use',
        });
      else {
        const images = await this.prisma.mediaAssetLabel.count({
          where: { labelId },
        });
        if (images === 0)
          issues.push({
            code: 'label_empty',
            message: 'The media label has no images',
          });
      }
    }
    const scenes = await this.sceneIssues(programStateId, recipe);
    issues.push(...scenes.issues);
    const items = expandRecipe(
      definition(recipe),
      { id: songId, artist: song?.artist ?? '', title: song?.title ?? '' },
      labelId,
      useId,
      scenes.bumperComponent,
    ) as FlightCue[];
    return { items, issues };
  }

  /**
   * Recipe scenes must still be this program's; the slideshow scene must have the slideshow component
   * and the bumper scene a component to point at the song (its first one). Each use re-points those two
   * scenes, so sharing them with another program is reported.
   */
  /**
   * The team that owns the program the recipe runs in. Artist links are written under the caller's
   * team and a catalog song carries no team of its own (gaulatti/alcantara#464), so the lookup
   * resolves under the program's team.
   */
  private async programTeam(programId: string): Promise<number | null> {
    const program = await this.prisma.program.findUnique({
      where: { programId },
      select: { teamId: true },
    });
    return program?.teamId ?? null;
  }

  private async sceneIssues(
    programStateId: number,
    recipe: RecipeView,
  ): Promise<{ issues: RecipeIssue[]; bumperComponent: string | null }> {
    const issues: RecipeIssue[] = [];
    let bumperComponent: string | null = null;
    const wanted: Array<[number | null, 'bumper' | 'slideshow' | 'return']> = [
      [recipe.bumperSceneId, 'bumper'],
      [recipe.slideshowSceneId, 'slideshow'],
      [recipe.returnSceneId, 'return'],
    ];
    for (const [sceneId, role] of wanted) {
      if (sceneId === null) continue;
      const scene = await this.prisma.scene.findUnique({
        where: { id: sceneId },
        select: {
          name: true,
          layout: { select: { componentType: true } },
          programScenes: { select: { programStateId: true } },
        },
      });
      const assigned = scene?.programScenes.some(
        (link) => link.programStateId === programStateId,
      );
      if (!scene || !assigned) {
        issues.push({
          code: 'scene_not_assigned',
          message: `The ${role} scene is not assigned to this program`,
        });
        continue;
      }
      if (role === 'return') continue;
      const components = scene.layout.componentType
        .split(',')
        .map((part) => part.trim());
      if (role === 'bumper') {
        bumperComponent = firstComponent(scene.layout.componentType);
        if (!bumperComponent)
          issues.push({
            code: 'scene_wrong_layout',
            message: `The bumper scene "${scene.name}" has no component`,
          });
      } else if (!components.includes(SLIDESHOW_COMPONENT)) {
        issues.push({
          code: 'scene_wrong_layout',
          message: `The slideshow scene "${scene.name}" has no ${SLIDESHOW_COMPONENT} component`,
        });
      }
      if (scene.programScenes.length > 1)
        issues.push({
          code: 'scene_shared',
          message: `The ${role} scene "${scene.name}" is assigned to ${scene.programScenes.length} programs; each use re-points it`,
        });
    }
    return { issues, bumperComponent };
  }

  /**
   * Builds again every use of `recipe` built from an older revision, in this program's operator
   * rundowns, that is wholly after the cue on air. Detached cues carry no tag and are never touched.
   */
  private async rebuild(
    programId: string,
    programStateId: number,
    recipe: RecipeView,
  ): Promise<number> {
    const sequences = await this.prisma.flightSequence.findMany({
      where: { programStateId, scheduledAt: null },
    });
    let rebuilt = 0;
    for (const sequence of sequences) {
      const items = Array.isArray(sequence.items)
        ? (sequence.items as unknown[])
        : [];
      const activeIndex =
        sequence.isRunning && sequence.activeItemId
          ? items.findIndex(
              (item) =>
                (item as { id?: unknown })?.id === sequence.activeItemId,
            )
          : -1;
      const uses = findRecipeUses(items).filter(
        (use) =>
          use.recipeId === recipe.id && use.recipeRevision < recipe.revision,
      );
      if (!uses.length) continue;
      let next = [...items];
      let changed = 0;
      for (const use of [...uses].reverse()) {
        if (use.start <= activeIndex) {
          this.metrics.recordRecipeRebuild('skipped');
          continue;
        }
        const { items: cues } = await this.build(
          programId,
          programStateId,
          recipe,
          use.params.songId,
          // A use built without a label looks the artist's label up again: one may have been attached since.
          use.params.labelId ?? undefined,
          use.useId,
        );
        next = [...next.slice(0, use.start), ...cues, ...next.slice(use.end)];
        changed += 1;
      }
      if (!changed) continue;
      try {
        await this.flights.updateFlightSequence(programId, sequence.id, {
          items: next,
          revision: sequence.revision,
        });
        rebuilt += changed;
        for (let index = 0; index < changed; index += 1)
          this.metrics.recordRecipeRebuild('rebuilt');
      } catch (error) {
        if (!(error instanceof ConflictException)) throw error;
        for (let index = 0; index < changed; index += 1)
          this.metrics.recordRecipeRebuild('conflict');
      }
    }
    return rebuilt;
  }

  private async fields(programStateId: number, input: RecipeInput) {
    const out: {
      name?: string;
      bumperSceneId?: number | null;
      slideshowSceneId?: number | null;
      returnSceneId?: number | null;
      transitionId?: string;
      holdMs?: number;
      steps?: RecipeStep[];
    } = {};
    if (input.name !== undefined) {
      if (
        typeof input.name !== 'string' ||
        !input.name.trim() ||
        input.name.trim().length > 200
      )
        throw new BadRequestException('name must be 1 to 200 characters');
      out.name = input.name.trim();
    }
    for (const field of [
      'bumperSceneId',
      'slideshowSceneId',
      'returnSceneId',
    ] as const) {
      if (input[field] === undefined) continue;
      const sceneId = sceneIdOf(input[field], field);
      if (sceneId !== null) {
        const link = await this.prisma.programScene.findFirst({
          where: { programStateId, sceneId },
        });
        if (!link)
          throw new BadRequestException(
            `${field} ${sceneId} is not assigned to this program`,
          );
      }
      out[field] = sceneId;
    }
    if (input.transitionId !== undefined) {
      if (
        typeof input.transitionId !== 'string' ||
        !input.transitionId.trim() ||
        input.transitionId.length > 64
      )
        throw new BadRequestException(
          'transitionId must be 1 to 64 characters',
        );
      out.transitionId = input.transitionId.trim();
    }
    if (input.holdMs !== undefined) {
      if (
        !Number.isInteger(input.holdMs) ||
        (input.holdMs as number) < 0 ||
        (input.holdMs as number) > MAX_HOLD_MS
      )
        throw new BadRequestException(
          `holdMs must be a whole number from 0 to ${MAX_HOLD_MS}`,
        );
      out.holdMs = input.holdMs as number;
    }
    if (input.steps !== undefined) {
      try {
        out.steps = normalizeRecipeSteps(input.steps);
      } catch (error) {
        throw new BadRequestException((error as Error).message);
      }
    }
    return out;
  }

  private async program(programId: string, visual = false) {
    const normalized = typeof programId === 'string' ? programId.trim() : '';
    if (!normalized) throw new BadRequestException('programId is required');
    const state = await this.prisma.programState.findUnique({
      where: { programId: normalized },
    });
    if (!state) throw new NotFoundException('program not found');
    if (visual && state.type === 'radio')
      throw new BadRequestException(
        'recipes need a program with a television leg',
      );
    return state;
  }

  private async recipe(
    programStateId: number,
    recipeId: number,
  ): Promise<RecipeRow> {
    const row = await this.prisma.rundownRecipe.findFirst({
      where: { id: recipeId, programStateId },
    });
    if (!row) throw new NotFoundException('recipe not found');
    return row;
  }

  private duplicate(error: unknown, name: string | undefined): unknown {
    if ((error as { code?: string } | null)?.code === 'P2002')
      return new BadRequestException(
        `a recipe named "${name}" already exists on this program`,
      );
    return error;
  }

  /**
   * gaulatti/alcantara#465: the uses of a recipe in the program's operator rundowns: per rundown, how
   * many uses and whether the rundown is running. Read by the delete and by its MCP dry run.
   */
  async usesOf(
    programId: string,
    recipeId: number,
  ): Promise<{
    recipe: RecipeView;
    uses: number;
    rundowns: Array<{
      id: number;
      name: string;
      uses: number;
      running: boolean;
      revision: number;
    }>;
  }> {
    const state = await this.program(programId);
    const recipe = toView(await this.recipe(state.id, recipeId));
    const sequences = await this.prisma.flightSequence.findMany({
      where: { programStateId: state.id, scheduledAt: null },
      orderBy: { id: 'asc' },
    });
    const rundowns = sequences
      .map((sequence) => {
        const items = Array.isArray(sequence.items)
          ? (sequence.items as unknown[])
          : [];
        const useIds = new Set(
          items
            .map(
              (item) =>
                (
                  item as {
                    recipeUse?: { recipeId?: unknown; useId?: unknown };
                  } | null
                )?.recipeUse,
            )
            .filter((tag) => tag?.recipeId === recipeId)
            .map((tag) => String(tag?.useId)),
        );
        return {
          id: sequence.id,
          name: sequence.name,
          uses: useIds.size,
          running: sequence.isRunning,
          revision: sequence.revision,
        };
      })
      .filter((rundown) => rundown.uses > 0);
    return {
      recipe,
      uses: rundowns.reduce((sum, rundown) => sum + rundown.uses, 0),
      rundowns,
    };
  }

  /**
   * gaulatti/alcantara#465: deletes a recipe read at `revision`. Refused (409 `on_air`) while a use of it
   * is in a running rundown, and (409 `has_uses`, with the count) while uses remain, unless `removeUses`,
   * which first removes the use cues from those rundowns through their normal update. Cues already aired
   * in the as-run need no recipe row.
   */
  async delete(
    programId: string,
    recipeId: number,
    options: { revision: unknown; removeUses?: boolean },
  ): Promise<{ deleted: number; removedUses: number }> {
    const { recipe, uses, rundowns } = await this.usesOf(programId, recipeId);
    const state = await this.program(programId);
    const refuse = (result: string, body: Record<string, unknown>) => {
      this.metrics.recordRecipeDelete(result);
      return new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        ...body,
      });
    };
    if (options.revision !== recipe.revision)
      throw refuse('conflict', {
        code: 'conflict',
        message: 'The recipe changed. Reload before deleting.',
      });
    const running = rundowns.find((rundown) => rundown.running);
    if (running)
      throw refuse('refused_on_air', {
        code: 'on_air',
        message: `A use of this recipe is in the running rundown "${running.name}". Stop it first.`,
      });
    if (uses > 0 && !options.removeUses)
      throw refuse('refused_has_uses', {
        code: 'has_uses',
        uses,
        message: `This recipe has ${uses} use(s) in ${rundowns.length} rundown(s). Remove them first, or delete with removeUses.`,
      });
    for (const rundown of rundowns) {
      const sequence = await this.prisma.flightSequence.findFirstOrThrow({
        where: { id: rundown.id },
      });
      const items = (
        Array.isArray(sequence.items) ? (sequence.items as unknown[]) : []
      ).filter(
        (item) =>
          (item as { recipeUse?: { recipeId?: unknown } } | null)?.recipeUse
            ?.recipeId !== recipeId,
      );
      try {
        await this.flights.updateFlightSequence(programId, rundown.id, {
          items,
          revision: sequence.revision,
        });
      } catch (error) {
        if (error instanceof ConflictException)
          this.metrics.recordRecipeDelete('conflict');
        throw error;
      }
    }
    const result = await this.prisma.rundownRecipe.deleteMany({
      where: {
        id: recipeId,
        programStateId: state.id,
        revision: recipe.revision,
      },
    });
    if (result.count !== 1)
      throw refuse('conflict', {
        code: 'conflict',
        message: 'The recipe changed. Reload before deleting.',
      });
    this.metrics.recordRecipeDelete('deleted');
    return { deleted: recipeId, removedUses: uses };
  }
}
