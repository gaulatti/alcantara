import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { ALCANTARA_PERMISSIONS } from '../../auth/permissions';
import { ProgramService } from '../../program/program.service';
import { ScenesService } from '../../scenes/scenes.service';
import { McpToolError, McpToolProvider, type McpToolSpec } from '../contract';
import {
  listPrograms,
  programIdsWhere,
  programsAffected,
  whyNot,
} from './on-air';
import { actionSpec, readSpec, rowIdArg, type Args } from './support';

const permissions = ALCANTARA_PERMISSIONS.scene;

const nameArg = z.string().trim().min(1).max(200);
const chyronArg = z.string().max(2000);
const metadataArg = z.record(z.string(), z.unknown());
const componentTypeArg = z.string().trim().min(1).max(200).optional();
const matchArg = z.number().int().min(1).max(15);

interface SceneRow {
  id: number;
  name: string;
}

/**
 * gaulatti/alcantara#216: the scene capabilities. Step 0 of scene_remove: the
 * console clears the scene from every program where it is on air (the picture
 * goes blank, `scene_cleared`), deletes it and its program assignments, and
 * leaves a staged pointer to it dangling, whatever is live. This capability
 * refuses with on_air while the scene is on air or staged on any program.
 */
@Injectable()
@McpToolProvider()
export class ScenesMcpTools {
  constructor(
    private readonly scenes: ScenesService,
    private readonly programs: ProgramService,
  ) {}

  /** The scene, or not_found where REST answers an empty 200. */
  private async requireScene(sceneId: number) {
    const scene = (await this.scenes.findOne(sceneId)) as SceneRow | null;
    if (!scene) throw new McpToolError('not_found', 'Scene not found');
    return scene;
  }

  /** The scene (not_found when absent) and the programs it is on air on. */
  private async sceneAndAir(sceneId: number) {
    const scene = await this.requireScene(sceneId);
    const onAirIn = await this.programs.getProgramIdsByActiveScene(sceneId);
    return { scene, onAirIn };
  }

  /** An A row on a scene: confirmed by the scene's name, planned from where it is on air. */
  private operate<
    S extends z.ZodRawShape & { scene_id: typeof rowIdArg },
  >(row: {
    name: string;
    title: string;
    description: string;
    shape: S;
    what: string;
    call: (args: Args<S>) => Promise<unknown>;
  }): McpToolSpec {
    const sceneOf = (args: Args<S>) => (args as { scene_id: number }).scene_id;
    return actionSpec({
      name: row.name,
      title: row.title,
      description: row.description,
      permission: permissions.operate,
      tier: 'A',
      shape: row.shape,
      load: (args) => this.sceneAndAir(sceneOf(args)),
      id: (args) => String(sceneOf(args)),
      label: (_args, { scene }) => scene.name,
      plan: (args, { scene, onAirIn }) => ({
        summary: `${row.what} on scene ${scene.id}. It is on air on ${onAirIn.length} program(s) (${onAirIn.join(', ')}), where viewers see the change at once.`,
        affects: [
          { kind: 'scene', id: String(scene.id), name: scene.name },
          ...programsAffected(onAirIn),
        ],
        recoverable: true,
      }),
      run: (args) => row.call(args),
    });
  }

  specs(): McpToolSpec[] {
    const bracket = { scene_id: rowIdArg, component_type: componentTypeArg };
    return [
      readSpec({
        name: 'scene_find_all',
        title: 'List scenes',
        description:
          'Lists every scene with its layout, newest first, as the console loads them.',
        permission: permissions.read,
        shape: {},
        run: () => this.scenes.findAll(),
      }),
      readSpec({
        name: 'scene_find_one',
        title: 'Get a scene',
        description: 'Reads one scene with its layout.',
        permission: permissions.read,
        shape: { scene_id: rowIdArg },
        run: (args) => this.requireScene(args.scene_id),
      }),
      actionSpec({
        name: 'scene_create',
        title: 'Create a scene',
        description:
          'Creates a scene on a layout. A video-stream layout needs external_source_id of a managed source and no source address in the metadata.',
        permission: permissions.manage,
        tier: 'W',
        shape: {
          name: nameArg,
          layout_id: rowIdArg,
          chyron_text: chyronArg.optional(),
          metadata: metadataArg.optional(),
          external_source_id: z.string().trim().min(1).max(200).optional(),
        },
        id: (args) => `layout:${args.layout_id}`,
        plan: (args) => ({
          summary: `Creates a scene on layout ${args.layout_id}; it is on no program until it is added to one.`,
          affects: [
            {
              kind: 'layout',
              id: String(args.layout_id),
              name: String(args.layout_id),
            },
          ],
          recoverable: true,
        }),
        run: (args) =>
          this.scenes.create({
            name: args.name,
            layoutId: args.layout_id,
            chyronText: args.chyron_text,
            metadata: args.metadata,
            externalSourceId: args.external_source_id,
          }),
      }),
      actionSpec({
        name: 'scene_update',
        title: 'Update a scene',
        description:
          'Changes the name, layout, chyron text, metadata or external source of a scene; only the fields given change. Where the scene is on air the change shows at once.',
        permission: permissions.manage,
        tier: 'W',
        shape: {
          scene_id: rowIdArg,
          name: nameArg.optional(),
          layout_id: rowIdArg.optional(),
          chyron_text: chyronArg.optional(),
          metadata: metadataArg.optional(),
          external_source_id: z
            .string()
            .trim()
            .min(1)
            .max(200)
            .nullable()
            .optional(),
        },
        load: (args) => this.sceneAndAir(args.scene_id),
        id: (args) => String(args.scene_id),
        plan: (args, { scene, onAirIn }) => ({
          summary: `Updates scene ${scene.id}; it is on air on ${onAirIn.length} program(s) (${onAirIn.join(', ')}). The previous values are not kept: read the scene first to restore them.`,
          affects: [
            { kind: 'scene', id: String(scene.id), name: scene.name },
            ...programsAffected(onAirIn),
          ],
          recoverable: true,
        }),
        onAir: (_args, { onAirIn }) => onAirIn.length > 0,
        run: (args) =>
          this.scenes.update(args.scene_id, {
            name: args.name,
            layoutId: args.layout_id,
            chyronText: args.chyron_text,
            metadata: args.metadata,
            externalSourceId: args.external_source_id,
          }),
      }),
      this.operate({
        name: 'scene_update_chyron',
        title: 'Change the chyron text of a scene',
        description:
          'Sets the chyron (lower-third) text of a scene; where the scene is on air, viewers see it at once.',
        shape: { scene_id: rowIdArg, chyron_text: chyronArg },
        what: 'Replaces the chyron text',
        call: (args) =>
          this.scenes.updateChyron(args.scene_id, args.chyron_text),
      }),
      this.operate({
        name: 'scene_draw_modo_italiano_bracket',
        title: 'Draw the next bracket slot',
        description:
          'Starts the animated draw that fills the next open opening slot of the scene bracket from its random song pool.',
        shape: { ...bracket, seed: z.number().int().optional() },
        what: 'Starts a bracket draw',
        call: (args) =>
          this.scenes.drawBracket(args.scene_id, {
            componentType: args.component_type,
            seed: args.seed,
          }),
      }),
      this.operate({
        name: 'scene_vote_modo_italiano_bracket',
        title: 'Record a bracket vote',
        description:
          "Records one registered voter's vote (a song of the match, or null to withdraw it) in the scene bracket; a majority decides the match.",
        shape: {
          ...bracket,
          match_id: matchArg,
          voter_id: z.string().trim().min(1).max(128),
          song_id: rowIdArg.nullable(),
        },
        what: 'Records a bracket vote',
        call: (args) =>
          this.scenes.voteBracket(args.scene_id, {
            componentType: args.component_type,
            matchId: args.match_id,
            voterId: args.voter_id,
            songId: args.song_id,
          }),
      }),
      this.operate({
        name: 'scene_open_modo_italiano_bracket_voting',
        title: 'Open bracket voting for a match',
        description:
          'Opens voting for one match of the scene bracket (both songs set, no winner yet).',
        shape: { ...bracket, match_id: matchArg },
        what: 'Opens bracket voting',
        call: (args) =>
          this.scenes.openBracketVoting(args.scene_id, {
            componentType: args.component_type,
            matchId: args.match_id,
          }),
      }),
      actionSpec({
        name: 'scene_remove',
        title: 'Delete a scene',
        description:
          'Deletes a scene and its program assignments. Refused with on_air while the scene is on air or staged on any program. Not recoverable.',
        permission: permissions.manage,
        tier: 'D',
        shape: { scene_id: rowIdArg },
        load: async (args) => {
          const scene = (await this.scenes.findOne(
            args.scene_id,
          )) as SceneRow | null;
          if (!scene) throw new McpToolError('not_found', 'Scene not found');
          const listed = await listPrograms(this.programs);
          return {
            scene,
            onAirIn: programIdsWhere(
              listed,
              (p) => p.activeSceneId === scene.id,
            ),
            stagedIn: programIdsWhere(
              listed,
              (p) => p.stagedSceneId === scene.id,
            ),
            assignedTo: programIdsWhere(listed, (p) =>
              p.scenes.some((entry) => entry.sceneId === scene.id),
            ),
          };
        },
        id: (args) => String(args.scene_id),
        label: (_args, { scene }) => scene.name,
        plan: (_args, { scene, assignedTo, onAirIn, stagedIn }) => ({
          summary: `Deletes scene ${scene.id} with its layout choice, chyron text and metadata (bracket state included) and removes it from ${assignedTo.length} program(s) (${assignedTo.join(', ')}). It cannot be recovered. The console deletes it even when it is on air (the picture goes blank) or staged; this capability refuses while it is on air on ${onAirIn.length} or staged on ${stagedIn.length} program(s).`,
          affects: [
            { kind: 'scene', id: String(scene.id), name: scene.name },
            ...programsAffected(assignedTo),
          ],
          recoverable: false,
        }),
        refuse: (_args, { scene, onAirIn, stagedIn }) =>
          whyNot([
            [
              onAirIn.length > 0,
              `scene ${scene.id} is on air on ${onAirIn.join(', ')}`,
            ],
            [
              stagedIn.length > 0,
              `scene ${scene.id} is staged on ${stagedIn.join(', ')}`,
            ],
          ]),
        run: (args) => this.scenes.remove(args.scene_id),
      }),
    ];
  }
}
