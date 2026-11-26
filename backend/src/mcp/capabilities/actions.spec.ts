/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return -- the controllers and services are exercised through loosely typed fakes. */
import { LayoutsController } from '../../layouts/layouts.controller';
import { MediaGroupsController } from '../../media-groups/media-groups.controller';
import { ProgramController } from '../../program/program.controller';
import { ScenesController } from '../../scenes/scenes.controller';
import {
  asRest,
  fakeServices,
  layout,
  rebuilt,
  scene,
  specNamed,
  stateOf,
  type Fakes,
} from './capabilities.testing';
import { assertNoCredential } from './support';
import { LayoutsMcpTools } from './layouts';
import { MediaGroupsMcpTools } from './media-groups';
import { ProgramMcpTools } from './program';
import { ScenesMcpTools } from './scenes';

// Every W, A and D capability against the real controller it stands for, with
// one set of fake services behind both: the same service method is reached with
// the same arguments, and the answer is the controller's (or, where the
// controller answers a whole program, its ids).

type Args = Record<string, unknown>;

interface Controllers {
  program: ProgramController;
  scenes: ScenesController;
  layouts: LayoutsController;
  groups: MediaGroupsController;
}

interface Case {
  args: Args;
  /** Arranges the fakes (what is live) before the call. */
  setup?: (f: Fakes) => void;
  /** The dry run says the change shows on air. */
  onAir?: boolean;
}

interface Row {
  name: string;
  cases: Case[];
  /** The console's call for the same input. */
  rest: (c: Controllers, args: Args) => Promise<unknown>;
  /** The service method both must reach. */
  service: (f: Fakes) => jest.Mock;
  /** The capability's answer from the console's (default: the same, text isolated). */
  expected?: (rest: any, args: Args) => unknown;
  /** The confirm name the capability asks for (A and D). */
  confirm?: [string, string];
}

const URL = 'https://cdn.example/manifest.json';
const stateIds = (rest: any) => ({
  program_id: rest.programId,
  type: rest.type,
  active_scene_id: rest.activeSceneId,
  staged_scene_id: rest.stagedSceneId,
  fade_to_black: rest.fadeToBlack,
  scene_ids: rest.scenes.map((entry: any) => entry.sceneId),
  media_group_ids: rest.mediaGroups.map((entry: any) => entry.mediaGroupId),
  stinger_ids: rest.stingers.map((entry: any) => entry.stingerId),
  version: rest.version,
});
const playbackIds = (rest: any) => ({
  program_id: rest.programId,
  scene_id: rest.sceneId,
  instant_id: rest.instantId,
  media_asset_id: rest.mediaAssetId,
  is_playing: rest.isPlaying,
  started_at: rest.startedAt,
  version: rest.version,
});
const live = (overrides: Args) => (f: Fakes) =>
  f.programs.getState.mockResolvedValue(stateOf(overrides));
const main = { program_id: 'main' };
const MAIN: [string, string] = ['main', 'scene:null fade:0 song:0 queue:0'];

const ROWS: Row[] = [
  {
    name: 'program_inspect_template',
    cases: [{ args: { template_url: URL } }],
    rest: (c) => c.program.inspectTemplate({ templateUrl: URL }),
    service: (f) => f.templates.inspect,
  },
  {
    name: 'program_create_program',
    cases: [
      { args: { program_id: 'news' } },
      { args: { program_id: 'news', type: 'tv', template_url: null } },
      { args: { program_id: 'news', type: 'both', template_url: '' } },
      { args: { program_id: 'news', type: 'radio' } },
      { args: { program_id: 'news', type: 'tv', template_url: URL } },
    ],
    rest: (c, a) =>
      c.program.createProgram(
        {
          programId: a.program_id as string,
          type: a.type as string,
          templateUrl: a.template_url as string,
        },
        { user: { authorization: { teamId: 7 } } } as never,
      ),
    service: (f) => f.programs.createProgram,
    expected: stateIds,
  },
  {
    name: 'program_rename_program',
    cases: [
      { args: { ...main, next_program_id: 'news2' }, onAir: false },
      {
        args: {
          ...main,
          next_program_id: 'news2',
          type: 'both',
          template_url: null,
        },
        setup: live({ activeSceneId: 3 }),
        onAir: true,
      },
    ],
    rest: (c, a) =>
      c.program.renameProgram('main', {
        nextProgramId: a.next_program_id as string,
        type: a.type as string,
        templateUrl: a.template_url as null,
      }),
    service: (f) => f.programs.renameProgram,
    expected: stateIds,
  },
  {
    name: 'program_delete_program',
    cases: [{ args: main }],
    rest: (c) => c.program.deleteProgram('main'),
    service: (f) => f.programs.deleteProgram,
    confirm: ['main', 'tv'],
  },
  {
    name: 'program_update_broadcast_settings',
    cases: [
      {
        args: {
          enabled: true,
          start_time: '06:30',
          song_master_volume: 0.5,
          mixer_channels: [{ id: 'song', volume: 1 }],
          song_muted: false,
        },
      },
      { args: {} },
    ],
    rest: (c, a) =>
      c.program.updateBroadcastSettings(
        {
          enabled: a.enabled as boolean,
          startTime: a.start_time as string,
          songMasterVolume: a.song_master_volume as number,
          mixerChannels: a.mixer_channels,
          songMuted: a.song_muted as boolean,
        } as never,
        { user: { authorization: { teamId: 7 } } },
      ),
    service: (f) => f.programs.updateBroadcastSettings,
    confirm: ['broadcast-settings', 'global'],
  },
  {
    name: 'program_take_program_scene_instant_by_id',
    cases: [
      {
        args: {
          ...main,
          scene_id: 3,
          instant_id: 8,
          media_asset_id: 'asset-1',
        },
      },
      { args: main },
    ],
    rest: (c, a) =>
      c.program.takeProgramSceneInstantById('main', {
        sceneId: a.scene_id as number,
        instantId: a.instant_id as number,
        mediaAssetId: a.media_asset_id as string,
      }),
    service: (f) => f.programs.takeProgramSceneInstant,
    expected: playbackIds,
    confirm: MAIN,
  },
  {
    name: 'program_stop_program_scene_instant_by_id',
    cases: [{ args: main }],
    rest: (c) => c.program.stopProgramSceneInstantById('main'),
    service: (f) => f.programs.stopProgramSceneInstant,
    expected: playbackIds,
    confirm: MAIN,
  },
  {
    name: 'program_enqueue_program_song_by_id',
    cases: [{ args: { ...main, item_id: 'i1' } }],
    rest: (c) => c.program.enqueueProgramSongById('main', { itemId: 'i1' }),
    service: (f) => f.programs.enqueueProgramSong,
    confirm: MAIN,
  },
  {
    name: 'program_reorder_program_song_queue_by_id',
    cases: [{ args: { ...main, entry_ids: ['e1'] } }],
    rest: (c) =>
      c.program.reorderProgramSongQueueById('main', { entryIds: ['e1'] }),
    service: (f) => f.programs.reorderProgramSongQueue,
    confirm: MAIN,
  },
  {
    name: 'program_remove_queued_program_song_by_id',
    cases: [{ args: { ...main, entry_id: 'e1' } }],
    rest: (c) => c.program.removeQueuedProgramSongById('main', 'e1'),
    service: (f) => f.programs.removeQueuedProgramSong,
  },
  {
    name: 'program_add_scene_to_program',
    cases: [{ args: { ...main, scene_id: 3 } }],
    rest: (c) => c.program.addSceneToProgram('main', { sceneId: 3 }),
    service: (f) => f.programs.addSceneToProgram,
    expected: stateIds,
  },
  {
    name: 'program_remove_scene_from_program',
    cases: [{ args: { ...main, scene_id: 3 } }],
    rest: (c) => c.program.removeSceneFromProgram('main', '3'),
    service: (f) => f.programs.removeSceneFromProgram,
    expected: stateIds,
    confirm: ['3', scene.name],
  },
  {
    name: 'program_add_media_group_to_program',
    cases: [{ args: { ...main, media_group_id: 5 } }],
    rest: (c) => c.program.addMediaGroupToProgram('main', { mediaGroupId: 5 }),
    service: (f) => f.programs.addMediaGroupToProgram,
    expected: stateIds,
  },
  {
    name: 'program_remove_media_group_from_program',
    cases: [{ args: { ...main, media_group_id: 5 } }],
    rest: (c) => c.program.removeMediaGroupFromProgram('main', '5'),
    service: (f) => f.programs.removeMediaGroupFromProgram,
    expected: stateIds,
    confirm: ['5', 'Headlines'],
  },
  {
    name: 'program_add_stinger_to_program',
    cases: [{ args: { ...main, stinger_id: 7 } }],
    rest: (c) => c.program.addStingerToProgram('main', { stingerId: 7 }),
    service: (f) => f.programs.addStingerToProgram,
    expected: stateIds,
  },
  {
    name: 'program_remove_stinger_from_program',
    cases: [{ args: { ...main, stinger_id: 7 } }],
    rest: (c) => c.program.removeStingerFromProgram('main', '7'),
    service: (f) => f.programs.removeStingerFromProgram,
    expected: stateIds,
    confirm: ['7', 'Whoosh'],
  },
  {
    name: 'program_activate_scene_by_id',
    cases: [
      { args: { ...main, scene_id: 3 } },
      {
        args: { ...main, scene_id: 3, transition_id: 'wipe' },
        setup: live({ activeSceneId: 3 }),
      },
    ],
    rest: (c, a) =>
      c.program.activateSceneById('main', {
        sceneId: 3,
        transitionId: a.transition_id as string,
      }),
    service: (f) => f.programs.activateScene,
    expected: stateIds,
    confirm: MAIN,
  },
  {
    name: 'program_stage_scene_by_id',
    cases: [
      { args: { ...main, scene_id: 3 }, setup: live({ stagedSceneId: 3 }) },
      { args: { ...main, scene_id: null } },
    ],
    rest: (c, a) =>
      c.program.stageSceneById('main', { sceneId: a.scene_id as number }),
    service: (f) => f.programs.stageScene,
  },
  {
    name: 'program_set_fade_to_black_by_id',
    cases: [
      { args: { ...main, active: true } },
      { args: { ...main, active: false } },
    ],
    rest: (c, a) =>
      c.program.setFadeToBlackById('main', { active: a.active as boolean }),
    service: (f) => f.programs.setFadeToBlack,
    expected: stateIds,
    confirm: MAIN,
  },
  {
    name: 'program_take_program_off_air_by_id',
    cases: [{ args: main }],
    rest: (c) => c.program.takeProgramOffAirById('main'),
    service: (f) => f.programs.takeProgramOffAir,
    expected: stateIds,
    confirm: MAIN,
  },
  {
    name: 'program_take_program_song_off_air_by_id',
    cases: [{ args: main }],
    rest: (c) => c.program.takeProgramSongOffAirById('main'),
    service: (f) => f.programs.takeProgramSongOffAir,
    confirm: MAIN,
  },
  {
    name: 'program_reload_program_by_id',
    cases: [{ args: main }],
    rest: (c) => c.program.reloadProgramById('main'),
    service: (f) => f.programs.requestProgramReload,
    confirm: MAIN,
  },
  {
    name: 'program_update_program_audio_bus_by_id',
    cases: [
      {
        args: {
          ...main,
          song_sequence: { mode: 'autoplay' },
          mixer_settings: { master: 1 },
        },
      },
      { args: main },
    ],
    rest: (c, a) =>
      c.program.updateProgramAudioBusById('main', {
        ...(a.song_sequence ? { songSequence: a.song_sequence } : {}),
        ...(a.mixer_settings ? { mixerSettings: a.mixer_settings } : {}),
      }),
    service: (f) => f.programs.updateProgramAudioBus,
    expected: (rest, a) => ({
      program_id: a.program_id,
      mixerSettings: rest.mixerSettings,
      version: rest.version,
    }),
    confirm: MAIN,
  },
  {
    name: 'program_activate_scene',
    cases: [
      { args: { ...main, scene_id: 3 } },
      {
        args: { ...main, scene_id: 3, transition_id: 'wipe' },
        setup: live({ activeSceneId: 4 }),
      },
    ],
    rest: (c, a) =>
      c.program.activateScene({
        sceneId: 3,
        transitionId: a.transition_id as string,
      }),
    service: (f) => f.programs.activateScene,
    expected: stateIds,
    confirm: MAIN,
  },
  {
    name: 'program_take_program_off_air',
    cases: [{ args: main }],
    rest: (c) => c.program.takeProgramOffAir(),
    service: (f) => f.programs.takeProgramOffAir,
    expected: stateIds,
    confirm: MAIN,
  },
  {
    name: 'program_take_program_song_off_air',
    cases: [{ args: main }],
    rest: (c) => c.program.takeProgramSongOffAir(),
    service: (f) => f.programs.takeProgramSongOffAir,
    confirm: MAIN,
  },
  {
    name: 'program_reload_program',
    cases: [{ args: main }],
    rest: (c) => c.program.reloadProgram(),
    service: (f) => f.programs.requestProgramReload,
    confirm: MAIN,
  },
  {
    name: 'scene_create',
    cases: [
      { args: { name: 'S', layout_id: 2 } },
      {
        args: {
          name: 'S',
          layout_id: 2,
          chyron_text: 'c',
          metadata: { a: 1 },
          external_source_id: 'src',
        },
      },
    ],
    rest: (c, a) =>
      c.scenes.create({
        name: a.name as string,
        layoutId: 2,
        chyronText: a.chyron_text as string,
        metadata: a.metadata,
        externalSourceId: a.external_source_id as string,
      }),
    service: (f) => f.scenes.create,
  },
  {
    name: 'scene_update',
    cases: [
      { args: { scene_id: 3, name: 'N' }, onAir: false },
      {
        args: {
          scene_id: 3,
          layout_id: 2,
          chyron_text: '',
          metadata: {},
          external_source_id: null,
        },
        setup: (f) =>
          f.programs.getProgramIdsByActiveScene.mockResolvedValue(['main']),
        onAir: true,
      },
    ],
    rest: (c, a) =>
      c.scenes.update('3', {
        name: a.name as string,
        layoutId: a.layout_id as number,
        chyronText: a.chyron_text as string,
        metadata: a.metadata,
        externalSourceId: a.external_source_id as null,
      }),
    service: (f) => f.scenes.update,
  },
  {
    name: 'scene_update_chyron',
    cases: [
      { args: { scene_id: 3, chyron_text: 'Breaking' } },
      {
        args: { scene_id: 3, chyron_text: 'Breaking' },
        setup: (f) =>
          f.programs.getProgramIdsByActiveScene.mockResolvedValue(['main']),
      },
    ],
    rest: (c) => c.scenes.updateChyron('3', { chyronText: 'Breaking' }),
    service: (f) => f.scenes.updateChyron,
    confirm: ['3', scene.name],
  },
  {
    name: 'scene_draw_modo_italiano_bracket',
    cases: [
      { args: { scene_id: 3 } },
      {
        args: { scene_id: 3, component_type: 'modoitaliano-bracket', seed: 7 },
      },
    ],
    rest: (c, a) =>
      c.scenes.drawModoItalianoBracket('3', {
        componentType: a.component_type as string,
        seed: a.seed as number,
      }),
    service: (f) => f.scenes.drawModoItalianoBracket,
    confirm: ['3', scene.name],
  },
  {
    name: 'scene_vote_modo_italiano_bracket',
    cases: [
      { args: { scene_id: 3, match_id: 1, voter_id: 'v1', song_id: 4 } },
      {
        args: {
          scene_id: 3,
          component_type: 'modoitaliano-bracket',
          match_id: 2,
          voter_id: 'v1',
          song_id: null,
        },
      },
    ],
    rest: (c, a) =>
      c.scenes.voteModoItalianoBracket('3', {
        componentType: a.component_type as string,
        matchId: a.match_id as number,
        voterId: a.voter_id as string,
        songId: a.song_id as number | null,
      }),
    service: (f) => f.scenes.voteModoItalianoBracket,
    confirm: ['3', scene.name],
  },
  {
    name: 'scene_open_modo_italiano_bracket_voting',
    cases: [{ args: { scene_id: 3, match_id: 1 } }],
    rest: (c) =>
      c.scenes.openModoItalianoBracketVoting('3', {
        componentType: undefined,
        matchId: 1,
      }),
    service: (f) => f.scenes.openModoItalianoBracketVoting,
    confirm: ['3', scene.name],
  },
  {
    name: 'scene_remove',
    cases: [{ args: { scene_id: 3 } }],
    rest: (c) => c.scenes.remove('3'),
    service: (f) => f.scenes.remove,
    confirm: ['3', scene.name],
  },
  {
    name: 'layout_create',
    cases: [
      { args: { name: 'L', component_type: 'grid' } },
      { args: { name: 'L', component_type: 'grid', settings: { a: 1 } } },
    ],
    rest: (c, a) =>
      c.layouts.create({
        name: 'L',
        componentType: 'grid',
        settings: a.settings,
      }),
    service: (f) => f.layouts.create,
  },
  {
    name: 'layout_update',
    cases: [
      { args: { layout_id: 2, name: 'L2' }, onAir: false },
      {
        args: { layout_id: 2, component_type: 'grid', settings: { b: 2 } },
        setup: (f) => {
          f.layouts.findOne.mockResolvedValue({
            ...layout,
            scenes: [{ id: 3 }],
          });
          f.programs.listPrograms.mockResolvedValue([
            stateOf({ activeSceneId: 3 }),
          ]);
        },
        onAir: true,
      },
    ],
    rest: (c, a) =>
      c.layouts.update('2', {
        name: a.name as string,
        componentType: a.component_type as string,
        settings: a.settings,
      }),
    service: (f) => f.layouts.update,
  },
  {
    name: 'layout_remove',
    cases: [{ args: { layout_id: 2 } }],
    rest: (c) => c.layouts.remove('2'),
    service: (f) => f.layouts.remove,
    confirm: ['2', layout.name],
  },
  {
    name: 'media_group_create',
    cases: [
      { args: { name: 'G' } },
      { args: { name: 'G', description: null, media_ids: [11] } },
    ],
    rest: (c, a) =>
      c.groups.create({
        name: 'G',
        description: a.description as null,
        mediaIds: a.media_ids as number[],
      }),
    service: (f) => f.groups.create,
    expected: (rest) => ({
      id: rest.id,
      createdAt: rest.createdAt,
      updatedAt: rest.updatedAt,
      mediaIds: rest.items.map((item: any) => item.mediaId),
      untrusted: { name: rest.name, description: rest.description },
    }),
  },
  {
    name: 'media_group_update',
    cases: [
      { args: { media_group_id: 5, name: 'G2' } },
      { args: { media_group_id: 5, description: null, media_ids: [] } },
    ],
    rest: (c, a) =>
      c.groups.update('5', {
        ...(a.name ? { name: a.name as string } : {}),
        ...(a.media_ids ? { mediaIds: a.media_ids as number[] } : {}),
        ...('description' in a ? { description: a.description as null } : {}),
      }),
    service: (f) => f.groups.update,
    expected: (rest) => ({
      id: rest.id,
      createdAt: rest.createdAt,
      updatedAt: rest.updatedAt,
      mediaIds: rest.items.map((item: any) => item.mediaId),
      untrusted: { name: rest.name, description: rest.description },
    }),
  },
  {
    name: 'media_group_remove',
    cases: [{ args: { media_group_id: 5 } }],
    rest: (c) => c.groups.remove('5'),
    service: (f) => f.groups.remove,
    confirm: ['5', 'Headlines'],
  },
];

function build() {
  const f = fakeServices();
  const controllers: Controllers = {
    program: new ProgramController(
      f.programs as never,
      {} as never,
      f.templates as never,
    ),
    scenes: new ScenesController(f.scenes as never),
    layouts: new LayoutsController(f.layouts as never),
    groups: new MediaGroupsController(f.groups as never),
  };
  const specs = [
    ...new ProgramMcpTools(
      f.programs as never,
      f.templates as never,
      { teamId: 7 } as never,
    ).specs(),
    ...new ScenesMcpTools(f.scenes as never, f.programs as never).specs(),
    ...new LayoutsMcpTools(f.layouts as never, f.programs as never).specs(),
    ...new MediaGroupsMcpTools(f.groups as never, f.programs as never).specs(),
  ];
  return { f, controllers, specs };
}

const ctx = { principal: {} as never };
const TABLE = ROWS.flatMap((row) =>
  row.cases.map((one, index) => [row.name, index, row, one] as const),
);

describe('write, on-air and destructive capabilities', () => {
  it('covers every non-read capability of the area exactly once', () => {
    const { specs } = build();
    expect(ROWS.map((row) => row.name).sort()).toEqual(
      specs
        .filter((spec) => spec.tier !== 'R')
        .map((spec) => spec.name)
        .sort(),
    );
  });

  it('refuses a radio program with a template before fetching anything', async () => {
    const { f, specs } = build();
    for (const name of ['program_create_program', 'program_rename_program']) {
      await expect(
        specNamed(specs, name).run(
          {
            program_id: 'main',
            next_program_id: 'x',
            type: 'radio',
            template_url: URL,
          },
          ctx,
        ),
      ).rejects.toMatchObject({
        code: 'invalid',
        message: 'Radio programs do not support visual templates',
      });
    }
    expect(f.templates.inspect).not.toHaveBeenCalled();
    expect(f.programs.createProgram).not.toHaveBeenCalled();
    expect(f.programs.renameProgram).not.toHaveBeenCalled();
  });

  it("reports the console's own refusals as MCP codes", async () => {
    const { f, specs } = build();
    f.programs.addSceneToProgram.mockRejectedValue(
      new Error('Program not found'),
    );
    await expect(
      specNamed(specs, 'program_add_scene_to_program').run(
        { program_id: 'main', scene_id: 3 },
        ctx,
      ),
    ).rejects.toMatchObject({ code: 'not_found' });
    f.programs.createProgram.mockRejectedValue(
      new Error('Program already exists'),
    );
    await expect(
      specNamed(specs, 'program_create_program').run(
        { program_id: 'main' },
        ctx,
      ),
    ).rejects.toMatchObject({ code: 'conflict' });
    f.programs.stageScene.mockRejectedValue(
      Object.assign(new Error('Scene is not assigned to this program'), {}),
    );
    await expect(
      specNamed(specs, 'program_stage_scene_by_id').run(
        { program_id: 'main', scene_id: 3 },
        ctx,
      ),
    ).rejects.toMatchObject({ code: 'invalid' });
  });

  it('reports a missing scene as not_found before any on-air action', async () => {
    const { f, specs } = build();
    f.scenes.findOne.mockResolvedValue(null);
    await expect(
      specNamed(specs, 'scene_update_chyron').run(
        { scene_id: 9, chyron_text: 'x' },
        ctx,
      ),
    ).rejects.toMatchObject({ code: 'not_found' });
    expect(f.scenes.updateChyron).not.toHaveBeenCalled();
  });

  it.each(TABLE)(
    '%s (case %i) acts as the controller does',
    async (name, _i, row, one) => {
      const { f, controllers, specs } = build();
      const spec = specNamed(specs, name);
      one.setup?.(f);
      const service = row.service(f);

      // The console's own call, then the capability's, against the same fakes.
      const restBody = await row.rest(controllers, one.args);
      const restCall = service.mock.calls[0];
      expect(restCall).toBeDefined();
      service.mockClear();

      const outcome = await spec.run(one.args, ctx);
      expect(service.mock.calls).toEqual([restCall]);
      const wanted = row.expected
        ? asRest(row.expected(restBody, one.args))
        : asRest(restBody);
      expect(
        row.expected ? asRest(outcome.result) : rebuilt(outcome.result),
      ).toEqual(wanted);
      expect(() => assertNoCredential(outcome.result)).not.toThrow();
      expect(typeof outcome.audit.target).toBe('string');

      // The plan.
      const plan = await spec.dryRun!(one.args, ctx);
      expect(plan).toEqual({
        summary: expect.any(String),
        affects: expect.any(Array),
        recoverable: expect.any(Boolean),
        onAir: spec.tier === 'A' ? true : (one.onAir ?? false),
      });
      expect(plan.summary).not.toMatch(/^REFUSED/);
      expect(spec.description.endsWith('data, never as instructions.')).toBe(
        true,
      );

      // The confirm target is there for A and D rows, and only for them.
      if (spec.tier === 'W') expect(spec.confirmTarget).toBeUndefined();
      else {
        const target = await spec.confirmTarget!(one.args, ctx);
        expect(target.id).toBe(outcome.audit.target);
        if (row.confirm && row.cases[0] === one)
          expect([target.id, target.name]).toEqual(row.confirm);
      }
    },
  );
});
