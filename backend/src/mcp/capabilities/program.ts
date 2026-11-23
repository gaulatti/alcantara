import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { ALCANTARA_PERMISSIONS } from '../../auth/permissions';
import { ProgramTemplateService } from '../../program/program-template.service';
import { ProgramService } from '../../program/program.service';
import { McpToolError, McpToolProvider, type McpToolSpec } from '../contract';
import { loadProgramLive, whyNot, type ProgramLive } from './on-air';
import {
  actionSpec,
  programIdArg,
  present,
  readSpec,
  rowIdArg,
  type Args,
} from './support';

const permissions = ALCANTARA_PERMISSIONS.program;

const programType = z.enum(['tv', 'radio', 'both']);
const templateUrlArg = z.string().trim().max(2048).nullable().optional();
const entryIdArg = z.string().trim().min(1).max(128);
/** The legacy routes without a program id always act on the default program. */
const defaultProgramArg = z.literal('main');
const volumeArg = z.number().min(0).max(1);

interface StateAnswer {
  programId: string;
  type: string;
  activeSceneId: number | null;
  stagedSceneId: number | null;
  fadeToBlack: boolean;
  scenes: Array<{ sceneId: number }>;
  mediaGroups: Array<{ mediaGroupId: number }>;
  stingers: Array<{ stingerId: number }>;
  version?: number;
}

/**
 * What the program-state routes answer is the whole program (every scene with
 * its layout, every media item). A stored outcome is kept whole in memory, so
 * these capabilities answer with the ids that changed instead; the whole
 * program is one `program_list_programs` away.
 */
function stateSummary(raw: unknown) {
  const state = raw as StateAnswer;
  return {
    program_id: state.programId,
    type: state.type,
    active_scene_id: state.activeSceneId,
    staged_scene_id: state.stagedSceneId,
    fade_to_black: state.fadeToBlack,
    scene_ids: state.scenes.map((entry) => entry.sceneId),
    media_group_ids: state.mediaGroups.map((entry) => entry.mediaGroupId),
    stinger_ids: state.stingers.map((entry) => entry.stingerId),
    version: state.version,
  };
}

interface PlaybackAnswer {
  programId: string;
  sceneId: number | null;
  instantId: number | null;
  mediaAssetId: string | null;
  isPlaying: boolean;
  startedAt: string | null;
  version: number;
}

/** The scene instant playback without the audio address of the instant. */
function playbackSummary(raw: unknown) {
  const playback = raw as PlaybackAnswer;
  return {
    program_id: playback.programId,
    scene_id: playback.sceneId,
    instant_id: playback.instantId,
    media_asset_id: playback.mediaAssetId,
    is_playing: playback.isPlaying,
    started_at: playback.startedAt,
    version: playback.version,
  };
}

interface ProgramRow<S extends z.ZodRawShape> {
  name: string;
  title: string;
  description: string;
  permission: McpToolSpec['permission'];
  tier: 'W' | 'A';
  shape: S;
  summary: (args: Args<S>, live: ProgramLive) => string;
  recoverable: boolean;
  onAir?: (args: Args<S>, live: ProgramLive) => boolean;
  call: (args: Args<S>) => Promise<unknown>;
  result?: (raw: unknown, args: Args<S>) => unknown;
}

/**
 * gaulatti/alcantara#216: the program capabilities (the program routes that
 * are not flight, radio, recording or broadcast). Each calls the service its
 * controller calls, in process, with the caller already authorized by the
 * registry. Actions on a program name it as `program_id`, which the action
 * executor spaces on-air runs by; the confirm name of an A row is the
 * program's live stamp, so a plan made before something went on or off air is
 * refused as `confirm_mismatch`.
 */
@Injectable()
@McpToolProvider()
export class ProgramMcpTools {
  constructor(
    private readonly programs: ProgramService,
    private readonly templates: ProgramTemplateService,
  ) {}

  /** A W or A row on one program: planned and confirmed from its live state. */
  private onProgram<S extends z.ZodRawShape>(row: ProgramRow<S>): McpToolSpec {
    const programOf = (args: Args<S>) =>
      (args as { program_id: string }).program_id;
    return actionSpec<S, ProgramLive>({
      name: row.name,
      title: row.title,
      description: row.description,
      permission: row.permission,
      tier: row.tier,
      shape: row.shape,
      load: (args) => loadProgramLive(this.programs, programOf(args)),
      id: programOf,
      label: (_args, live) => live.stamp,
      plan: (args, live) => ({
        summary: row.summary(args, live),
        affects: [
          { kind: 'program', id: programOf(args), name: programOf(args) },
        ],
        recoverable: row.recoverable,
      }),
      onAir: row.onAir,
      run: (args) => row.call(args),
      result: row.result,
    });
  }

  private async registration(templateUrl: string | null | undefined) {
    if (templateUrl === undefined) return undefined;
    if (templateUrl === null || templateUrl === '') return null;
    return this.templates.inspect(templateUrl);
  }

  private rejectRadioTemplate(
    type: string | undefined,
    templateUrl: string | null | undefined,
  ): void {
    if (type === 'radio' && templateUrl)
      throw new McpToolError(
        'invalid',
        'Radio programs do not support visual templates',
      );
  }

  specs(): McpToolSpec[] {
    return [
      ...this.reads(),
      ...this.programManagement(),
      ...this.sceneActions(),
      ...this.queueActions(),
      ...this.assignments(),
      ...this.liveControls(),
      ...this.defaultProgram(),
    ];
  }

  private reads(): McpToolSpec[] {
    return [
      readSpec({
        name: 'program_list_programs',
        title: 'List programs in full',
        description:
          'Lists every program with its type, template, scenes, media groups, stingers, flight sequences and audio settings, as the console loads them.',
        permission: permissions.read,
        shape: {},
        run: () => this.programs.listPrograms(),
      }),
      readSpec({
        name: 'program_get_staged_scene_by_id',
        title: 'Get the staged scene of a program',
        description:
          'Reads the scene staged to go on air next on a television program (null when none).',
        permission: permissions.read,
        shape: { program_id: programIdArg },
        run: (args) => this.programs.getStagedScene(args.program_id),
      }),
    ];
  }

  private programManagement(): McpToolSpec[] {
    return [
      actionSpec({
        name: 'program_inspect_template',
        title: 'Inspect a program template',
        description:
          'Fetches a program template manifest (public https only, under the outbound-request policy) and reports what it declares. Nothing is stored.',
        permission: permissions.manage,
        tier: 'W',
        shape: { template_url: z.string().trim().min(1).max(2048) },
        id: () => 'template',
        plan: () => ({
          summary:
            'Fetches the template manifest at the given address and reports its contents; nothing is stored or changed.',
          affects: [],
          recoverable: true,
        }),
        run: (args) => this.templates.inspect(args.template_url),
      }),
      actionSpec({
        name: 'program_create_program',
        title: 'Create a program',
        description:
          'Creates a program (tv by default; radio programs take no visual template) and returns its ids.',
        permission: permissions.manage,
        tier: 'W',
        shape: {
          program_id: programIdArg,
          type: programType.optional(),
          template_url: templateUrlArg,
        },
        id: (args) => args.program_id,
        plan: (args) => ({
          summary: `Creates the ${args.type ?? 'tv'} program ${args.program_id}; it starts empty and off air.`,
          affects: [
            { kind: 'program', id: args.program_id, name: args.program_id },
          ],
          recoverable: true,
        }),
        run: async (args) => {
          this.rejectRadioTemplate(args.type, args.template_url);
          const template = await this.registration(args.template_url);
          return this.programs.createProgram(
            args.program_id,
            args.type,
            template,
          );
        },
        result: stateSummary,
      }),
      actionSpec({
        name: 'program_rename_program',
        title: 'Rename a program or change its type or template',
        description:
          'Renames a program, changes its type, or sets (or clears, with null) its template. A radio program loses its scenes, media groups, stingers and template.',
        permission: permissions.manage,
        tier: 'W',
        shape: {
          program_id: programIdArg,
          next_program_id: programIdArg,
          type: programType.optional(),
          template_url: templateUrlArg,
        },
        load: (args) => loadProgramLive(this.programs, args.program_id),
        id: (args) => args.program_id,
        plan: (args, live) => ({
          summary: `Renames program ${args.program_id} to ${args.next_program_id}; the type and template change only when given. Players that use the old id lose it. Live now: ${live.liveText}.`,
          affects: [
            {
              kind: 'program',
              id: args.program_id,
              name: args.next_program_id,
            },
          ],
          recoverable: true,
        }),
        onAir: (_args, live) => live.reasons.length > 0,
        run: async (args) => {
          this.rejectRadioTemplate(args.type, args.template_url);
          const template = await this.registration(args.template_url);
          return this.programs.renameProgram(
            args.program_id,
            args.next_program_id,
            args.type,
            template,
          );
        },
        result: stateSummary,
      }),
      actionSpec({
        name: 'program_delete_program',
        title: 'Delete a program',
        description:
          'Deletes a program with its scene, media group and stinger assignments, flight sequences, song queue and rotation, audio mixer and radio settings. Refused with on_air while the program is live. Not recoverable.',
        permission: permissions.manage,
        tier: 'D',
        shape: { program_id: programIdArg },
        load: (args) => loadProgramLive(this.programs, args.program_id),
        id: (args) => args.program_id,
        label: (_args, live) => live.type,
        plan: (args, live) => ({
          summary: `Deletes program ${args.program_id} (${live.type}) with ${live.scenes.length} scene, ${live.mediaGroups.length} media group and ${live.stingers.length} stinger assignment(s), ${live.flightSequences} flight sequence(s), its song queue, rotation, audio mixer and radio settings. The scenes, media groups and stingers themselves stay. It cannot be recovered; recreate it and re-add everything by hand. The console deletes without looking at what is live; this capability refuses while the program is live (${live.liveText}).`,
          affects: [
            { kind: 'program', id: args.program_id, name: args.program_id },
          ],
          recoverable: false,
        }),
        refuse: (args, live) =>
          whyNot([
            [
              live.reasons.length > 0,
              `program ${args.program_id} is live: ${live.liveText}`,
            ],
          ]),
        run: (args) => this.programs.deleteProgram(args.program_id),
      }),
    ];
  }

  private sceneActions(): McpToolSpec[] {
    const sceneChoice = {
      scene_id: rowIdArg.nullable().optional(),
    };
    return [
      this.onProgram({
        name: 'program_take_program_scene_instant_by_id',
        title: 'Take a scene background instant on air',
        description:
          'Plays the background audio of a scene (the configured one, or the instant or media asset named) on a program, on loop, until it is stopped.',
        permission: permissions.operate,
        tier: 'A',
        shape: {
          program_id: programIdArg,
          ...sceneChoice,
          instant_id: rowIdArg.nullable().optional(),
          media_asset_id: z
            .string()
            .trim()
            .min(1)
            .max(200)
            .nullable()
            .optional(),
        },
        summary: (args, live) =>
          `Plays the background audio of scene ${args.scene_id ?? 'on air'} on program ${args.program_id}, on loop, over whatever is playing there. Live now: ${live.liveText}.`,
        recoverable: true,
        call: (args) =>
          this.programs.takeProgramSceneInstant(
            args.scene_id ?? null,
            args.program_id,
            args.instant_id ?? null,
            args.media_asset_id ?? null,
          ),
        result: playbackSummary,
      }),
      this.onProgram({
        name: 'program_stop_program_scene_instant_by_id',
        title: 'Stop the scene background instant',
        description: 'Stops the scene background audio playing on a program.',
        permission: permissions.operate,
        tier: 'A',
        shape: { program_id: programIdArg },
        summary: (args, live) =>
          `Stops the scene background audio on program ${args.program_id}. Live now: ${live.liveText}.`,
        recoverable: true,
        call: (args) => this.programs.stopProgramSceneInstant(args.program_id),
        result: playbackSummary,
      }),
      this.onProgram({
        name: 'program_activate_scene_by_id',
        title: 'Put a scene on air',
        description:
          'Puts an assigned scene on air on a television program; the scene it replaces becomes the staged scene.',
        permission: permissions.operate,
        tier: 'A',
        shape: {
          program_id: programIdArg,
          scene_id: rowIdArg,
          transition_id: z.string().max(200).nullable().optional(),
        },
        summary: (args, live) =>
          `Puts scene ${args.scene_id} on air on program ${args.program_id}, replacing ${live.activeSceneId === null ? 'nothing' : `scene ${live.activeSceneId}`}, which becomes the staged scene. Live now: ${live.liveText}.`,
        recoverable: true,
        call: (args) =>
          this.programs.activateScene(
            args.scene_id,
            args.program_id,
            args.transition_id,
          ),
        result: stateSummary,
      }),
      this.onProgram({
        name: 'program_stage_scene_by_id',
        title: 'Stage a scene',
        description:
          'Stages an assigned scene to go on air next on a television program, or clears the staged scene with null.',
        permission: permissions.operate,
        tier: 'A',
        shape: { program_id: programIdArg, ...sceneChoice },
        summary: (args, live) =>
          `Stages ${args.scene_id ? `scene ${args.scene_id}` : 'no scene'} on program ${args.program_id} (staged now: ${live.stagedSceneId ?? 'none'}). The staged scene is not on air until it is activated.`,
        recoverable: true,
        call: (args) =>
          this.programs.stageScene(args.scene_id ?? null, args.program_id),
      }),
      this.onProgram({
        name: 'program_set_fade_to_black_by_id',
        title: 'Fade a program to black',
        description: 'Turns fade to black on or off on a television program.',
        permission: permissions.operate,
        tier: 'A',
        shape: { program_id: programIdArg, active: z.boolean() },
        summary: (args, live) =>
          `Turns fade to black ${args.active ? 'on' : 'off'} on program ${args.program_id}; the picture goes ${args.active ? 'black' : 'back to the scene on air'}. Live now: ${live.liveText}.`,
        recoverable: true,
        call: (args) =>
          this.programs.setFadeToBlack(args.active, args.program_id),
        result: stateSummary,
      }),
      this.onProgram({
        name: 'program_take_program_off_air_by_id',
        title: 'Take a program off air',
        description:
          'Takes the scene on air (and fade to black) off a program and stops its scene background audio.',
        permission: permissions.operate,
        tier: 'A',
        shape: { program_id: programIdArg },
        summary: (args, live) =>
          `Takes program ${args.program_id} off air: the picture and scene background audio stop. Live now: ${live.liveText}. Put the scene back with program_activate_scene_by_id.`,
        recoverable: true,
        call: (args) => this.programs.takeProgramOffAir(args.program_id),
        result: stateSummary,
      }),
    ];
  }

  private queueActions(): McpToolSpec[] {
    return [
      this.onProgram({
        name: 'program_enqueue_program_song_by_id',
        title: 'Queue a song to play next',
        description:
          'Adds a song of the program playlist to the Play Next queue (at most 100 entries).',
        permission: permissions.operate,
        tier: 'A',
        shape: { program_id: programIdArg, item_id: entryIdArg },
        summary: (args, live) =>
          `Adds playlist item ${args.item_id} to the end of the Play Next queue of program ${args.program_id} (${live.queued} queued now); it plays after the queued songs ahead of it. Remove it with program_remove_queued_program_song_by_id until it plays.`,
        recoverable: true,
        call: (args) =>
          this.programs.enqueueProgramSong(args.program_id, args.item_id),
      }),
      this.onProgram({
        name: 'program_reorder_program_song_queue_by_id',
        title: 'Reorder the Play Next queue',
        description:
          'Sets the order of the Play Next queue; the ids must be exactly the queued entries.',
        permission: permissions.operate,
        tier: 'A',
        shape: {
          program_id: programIdArg,
          entry_ids: z.array(entryIdArg).max(100),
        },
        summary: (args, live) =>
          `Reorders the ${live.queued} queued song(s) of program ${args.program_id} into the ${args.entry_ids.length} ids given; the song playing keeps its place.`,
        recoverable: true,
        call: (args) =>
          this.programs.reorderProgramSongQueue(
            args.program_id,
            args.entry_ids,
          ),
      }),
      this.onProgram({
        name: 'program_remove_queued_program_song_by_id',
        title: 'Remove a queued song',
        description:
          'Removes one entry from the Play Next queue (not the one playing).',
        permission: permissions.operate,
        tier: 'W',
        shape: { program_id: programIdArg, entry_id: entryIdArg },
        summary: (args, live) =>
          `Removes queue entry ${args.entry_id} from program ${args.program_id} (${live.queued} queued now). Queue the song again to undo.`,
        recoverable: true,
        call: (args) =>
          this.programs.removeQueuedProgramSong(args.program_id, args.entry_id),
      }),
      this.onProgram({
        name: 'program_take_program_song_off_air_by_id',
        title: 'Stop the song on a program',
        description:
          'Stops the song playing on a program and turns its rotation to manual (the operator Stop).',
        permission: permissions.operate,
        tier: 'A',
        shape: { program_id: programIdArg },
        summary: (args, live) =>
          `Cuts the song playing on program ${args.program_id} and turns its rotation to manual. Live now: ${live.liveText}. The song is cut mid-air and starts from its beginning if played again.`,
        recoverable: false,
        call: (args) => this.programs.takeProgramSongOffAir(args.program_id),
      }),
    ];
  }

  private assignments(): McpToolSpec[] {
    return [
      this.onProgram({
        name: 'program_add_scene_to_program',
        title: 'Add a scene to a program',
        description:
          'Assigns a scene to a television program (radio programs take no scenes).',
        permission: permissions.manage,
        tier: 'W',
        shape: { program_id: programIdArg, scene_id: rowIdArg },
        summary: (args) =>
          `Adds scene ${args.scene_id} to the end of the scenes of program ${args.program_id}; nothing goes on air.`,
        recoverable: true,
        call: (args) =>
          this.programs.addSceneToProgram(args.scene_id, args.program_id),
        result: stateSummary,
      }),
      this.onProgram({
        name: 'program_add_media_group_to_program',
        title: 'Add a media group to a program',
        description: 'Assigns a media group to a television program.',
        permission: permissions.manage,
        tier: 'W',
        shape: { program_id: programIdArg, media_group_id: rowIdArg },
        summary: (args) =>
          `Adds media group ${args.media_group_id} to program ${args.program_id}.`,
        recoverable: true,
        call: (args) =>
          this.programs.addMediaGroupToProgram(
            args.media_group_id,
            args.program_id,
          ),
        result: stateSummary,
      }),
      this.onProgram({
        name: 'program_add_stinger_to_program',
        title: 'Add a stinger to a program',
        description: 'Assigns a stinger to a television program.',
        permission: permissions.manage,
        tier: 'W',
        shape: { program_id: programIdArg, stinger_id: rowIdArg },
        summary: (args) =>
          `Adds stinger ${args.stinger_id} to program ${args.program_id}.`,
        recoverable: true,
        call: (args) =>
          this.programs.addStingerToProgram(args.stinger_id, args.program_id),
        result: stateSummary,
      }),
      this.removal({
        name: 'program_remove_scene_from_program',
        title: 'Remove a scene from a program',
        description:
          'Takes a scene off the scene list of a program. Refused with on_air while the scene is on air, staged, or playing its background audio there.',
        what: 'scene',
        shape: { program_id: programIdArg, scene_id: rowIdArg },
        entry: (args, live) => live.scenes.find((s) => s.id === args.scene_id),
        refuse: (args, live) =>
          whyNot([
            [
              live.activeSceneId === args.scene_id,
              `scene ${args.scene_id} is on air on ${args.program_id}`,
            ],
            [
              live.stagedSceneId === args.scene_id,
              `scene ${args.scene_id} is staged on ${args.program_id}`,
            ],
            [
              live.instantSceneId === args.scene_id,
              `scene ${args.scene_id} is playing its background audio on ${args.program_id}`,
            ],
          ]),
        lost: 'its place in the scene list (it returns at the end when added again) and, were it on air or staged, that status',
        call: (args) =>
          this.programs.removeSceneFromProgram(args.scene_id, args.program_id),
      }),
      this.removal({
        name: 'program_remove_media_group_from_program',
        title: 'Remove a media group from a program',
        description:
          'Takes a media group off a program. Refused with on_air while the program has a scene or fade to black on air, because the live page reads its media groups.',
        what: 'media group',
        shape: { program_id: programIdArg, media_group_id: rowIdArg },
        entry: (args, live) =>
          live.mediaGroups.find((g) => g.id === args.media_group_id),
        refuse: (args, live) =>
          whyNot([
            [
              live.visuallyOnAir,
              `program ${args.program_id} is on air and its live page reads its media groups`,
            ],
          ]),
        lost: 'its place in the media group list (it returns at the end when added again)',
        call: (args) =>
          this.programs.removeMediaGroupFromProgram(
            args.media_group_id,
            args.program_id,
          ),
      }),
      this.removal({
        name: 'program_remove_stinger_from_program',
        title: 'Remove a stinger from a program',
        description:
          'Takes a stinger off a program. Refused with on_air while the program has a scene or fade to black on air, because its scene changes use the stingers.',
        what: 'stinger',
        shape: { program_id: programIdArg, stinger_id: rowIdArg },
        entry: (args, live) =>
          live.stingers.find((s) => s.id === args.stinger_id),
        refuse: (args, live) =>
          whyNot([
            [
              live.visuallyOnAir,
              `program ${args.program_id} is on air and its scene changes use its stingers`,
            ],
          ]),
        lost: 'its place in the stinger list (it returns at the end when added again)',
        call: (args) =>
          this.programs.removeStingerFromProgram(
            args.stinger_id,
            args.program_id,
          ),
      }),
    ];
  }

  /** A D row that takes one entry off a program, refused while it is in use. */
  private removal<S extends z.ZodRawShape>(row: {
    name: string;
    title: string;
    description: string;
    what: string;
    shape: S;
    entry: (
      args: Args<S>,
      live: ProgramLive,
    ) => { id: number; name: string } | undefined;
    refuse: (args: Args<S>, live: ProgramLive) => string | null;
    lost: string;
    call: (args: Args<S>) => Promise<unknown>;
  }): McpToolSpec {
    const programOf = (args: Args<S>) =>
      (args as { program_id: string }).program_id;
    return actionSpec<
      S,
      { live: ProgramLive; entry: { id: number; name: string } }
    >({
      name: row.name,
      title: row.title,
      description: row.description,
      permission: permissions.manage,
      tier: 'D',
      shape: row.shape,
      load: async (args) => {
        const live = await loadProgramLive(this.programs, programOf(args));
        const entry = row.entry(args, live);
        if (!entry)
          throw new McpToolError(
            'not_found',
            `The ${row.what} is not assigned to this program.`,
          );
        return { live, entry };
      },
      id: (_args, { entry }) => String(entry.id),
      label: (_args, { entry }) => entry.name,
      plan: (args, { live, entry }) => ({
        summary: `Takes ${row.what} ${entry.id} off program ${programOf(args)}. Lost: ${row.lost}. The ${row.what} itself stays and can be added again. The console does this without looking at what is live; this capability refuses while it is in use (live now: ${live.liveText}).`,
        affects: [
          { kind: row.what, id: String(entry.id), name: entry.name },
          { kind: 'program', id: programOf(args), name: programOf(args) },
        ],
        recoverable: true,
      }),
      refuse: (args, { live }) => row.refuse(args, live),
      run: (args) => row.call(args),
      result: stateSummary,
    });
  }

  private liveControls(): McpToolSpec[] {
    const mixerFields = {
      enabled: z.boolean().optional(),
      start_time: z
        .string()
        .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
        .nullable()
        .optional(),
      mixer_channels: z
        .array(z.record(z.string(), z.unknown()))
        .max(16)
        .optional(),
      main_master_volume: volumeArg.optional(),
      song_master_volume: volumeArg.optional(),
      instant_master_volume: volumeArg.optional(),
      stream_master_volume: volumeArg.optional(),
      scene_instant_master_volume: volumeArg.optional(),
      song_muted: z.boolean().optional(),
      instant_muted: z.boolean().optional(),
      stream_muted: z.boolean().optional(),
      scene_instant_muted: z.boolean().optional(),
      song_solo: z.boolean().optional(),
      instant_solo: z.boolean().optional(),
      stream_solo: z.boolean().optional(),
      scene_instant_solo: z.boolean().optional(),
    };
    const camel = (key: string) =>
      key.replace(/_([a-z])/g, (_match, letter: string) =>
        letter.toUpperCase(),
      );
    return [
      actionSpec({
        name: 'program_update_broadcast_settings',
        title: 'Update the global broadcast settings',
        description:
          'Changes the global broadcast settings (time override, mixer levels, mute and solo) that every program reads. Only the fields given change; volumes are 0 to 1.',
        permission: permissions.operate,
        tier: 'A',
        shape: mixerFields,
        id: () => 'broadcast-settings',
        label: () => 'global',
        plan: (args) => ({
          summary: `Changes ${Object.keys(present(args)).length} global broadcast setting(s) (${Object.keys(present(args)).join(', ')}) for every program at once. The previous values are not kept: read them first to restore them.`,
          affects: [
            {
              kind: 'broadcast_settings',
              id: 'broadcast-settings',
              name: 'global',
            },
          ],
          recoverable: true,
        }),
        run: (args) =>
          this.programs.updateBroadcastSettings(
            Object.fromEntries(
              Object.entries(present(args)).map(([key, value]) => [
                camel(key),
                value,
              ]),
            ),
          ),
      }),
      this.onProgram({
        name: 'program_update_program_audio_bus_by_id',
        title: 'Update the audio bus of a program',
        description:
          'Replaces the song sequence (playlist and rotation mode) and/or the mixer settings of a program. Only the parts given change. The answer carries the mixer settings and version, not the playlist.',
        permission: permissions.operate,
        tier: 'A',
        shape: {
          program_id: programIdArg,
          song_sequence: z.record(z.string(), z.unknown()).optional(),
          mixer_settings: z.record(z.string(), z.unknown()).optional(),
        },
        summary: (args, live) =>
          `Changes the ${Object.keys(present({ song_sequence: args.song_sequence, mixer_settings: args.mixer_settings })).join(' and ') || 'nothing'} of program ${args.program_id}. A new song sequence replaces the playlist and rotation the engine follows. Live now: ${live.liveText}. The previous values are not kept: read them first to restore them.`,
        recoverable: true,
        call: (args) =>
          this.programs.updateProgramAudioBus(
            present({
              songSequence: args.song_sequence,
              mixerSettings: args.mixer_settings,
            }),
            args.program_id,
          ),
        result: (raw, args) => ({
          program_id: args.program_id,
          mixerSettings: (raw as { mixerSettings: unknown }).mixerSettings,
          version: (raw as { version: number }).version,
        }),
      }),
      this.onProgram({
        name: 'program_remove_program_song_leaves_by_id',
        title: 'Remove songs from the playlist of a program by leaf id',
        description:
          'Removes exactly the playlist leaves with these ids (1 to 200, nested blocks included) and changes nothing else: the rotation cursor is the live one, never rewritten from an old read. An unknown id is refused. Removing the leaf on air is refused unless keep_rotation is set, which moves the rotation to the next leaf. With dry_run the leaves that would go and the leaf counts before and after are returned and nothing is written.',
        permission: permissions.operate,
        tier: 'A',
        shape: {
          program_id: programIdArg,
          leaf_ids: z.array(z.string().min(1)).min(1).max(200),
          keep_rotation: z.boolean().optional(),
          dry_run: z.boolean().optional(),
        },
        summary: (args, live) =>
          args.dry_run === true
            ? `Lists the ${args.leaf_ids.length} playlist leaf(s) of program ${args.program_id} that would be removed; nothing is written. Live now: ${live.liveText}.`
            : `Removes ${args.leaf_ids.length} leaf(s) from the playlist of program ${args.program_id}; the rotation keeps its place${args.keep_rotation ? ' (moved on if the leaf on air is among them)' : ''}. Live now: ${live.liveText}. Removed leaves are not kept: a dry run lists them first.`,
        recoverable: false,
        call: (args) =>
          this.programs.removeProgramSongLeaves(
            args.program_id,
            args.leaf_ids,
            {
              keepRotation: args.keep_rotation,
              dryRun: args.dry_run,
            },
          ),
        result: (raw, args) => ({
          program_id: args.program_id,
          ...(raw as object),
        }),
      }),
      this.onProgram({
        name: 'program_reload_program_by_id',
        title: 'Reload the live pages of a program',
        description:
          'Tells every live page of a program to reload. Viewers see a brief interruption.',
        permission: permissions.operate,
        tier: 'A',
        shape: { program_id: programIdArg },
        summary: (args, live) =>
          `Reloads every live page of program ${args.program_id}; viewers see a brief interruption. Live now: ${live.liveText}.`,
        recoverable: true,
        call: (args) => this.programs.requestProgramReload(args.program_id),
      }),
    ];
  }

  /** The routes with no program id, which always act on the program `main`. */
  private defaultProgram(): McpToolSpec[] {
    const main = { program_id: defaultProgramArg };
    return [
      this.onProgram({
        name: 'program_activate_scene',
        title: 'Put a scene on air on the default program',
        description:
          "Puts an assigned scene on air on the default program ('main'); the scene it replaces becomes the staged scene.",
        permission: permissions.operate,
        tier: 'A',
        shape: {
          ...main,
          scene_id: rowIdArg,
          transition_id: z.string().max(200).nullable().optional(),
        },
        summary: (args, live) =>
          `Puts scene ${args.scene_id} on air on the default program, replacing ${live.activeSceneId === null ? 'nothing' : `scene ${live.activeSceneId}`}. Live now: ${live.liveText}.`,
        recoverable: true,
        call: (args) =>
          this.programs.activateScene(
            args.scene_id,
            undefined,
            args.transition_id,
          ),
        result: stateSummary,
      }),
      this.onProgram({
        name: 'program_take_program_off_air',
        title: 'Take the default program off air',
        description:
          "Takes the scene on air (and fade to black) off the default program ('main').",
        permission: permissions.operate,
        tier: 'A',
        shape: main,
        summary: (_args, live) =>
          `Takes the default program off air. Live now: ${live.liveText}.`,
        recoverable: true,
        call: () => this.programs.takeProgramOffAir(),
        result: stateSummary,
      }),
      this.onProgram({
        name: 'program_take_program_song_off_air',
        title: 'Stop the song on the default program',
        description:
          "Stops the song playing on the default program ('main') and turns its rotation to manual.",
        permission: permissions.operate,
        tier: 'A',
        shape: main,
        summary: (_args, live) =>
          `Cuts the song playing on the default program and turns its rotation to manual. Live now: ${live.liveText}.`,
        recoverable: false,
        call: () => this.programs.takeProgramSongOffAir(),
      }),
      this.onProgram({
        name: 'program_reload_program',
        title: 'Reload the live pages of the default program',
        description:
          "Tells every live page of the default program ('main') to reload.",
        permission: permissions.operate,
        tier: 'A',
        shape: main,
        summary: (_args, live) =>
          `Reloads every live page of the default program. Live now: ${live.liveText}.`,
        recoverable: true,
        call: () => this.programs.requestProgramReload(),
      }),
    ];
  }
}
