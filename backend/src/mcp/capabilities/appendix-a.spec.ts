import { ALCANTARA_PERMISSIONS } from '../../auth/permissions';
import { REQUIRED_PERMISSION_KEY } from '../../auth/require-permission.decorator';
import { LayoutsController } from '../../layouts/layouts.controller';
import { MediaGroupsController } from '../../media-groups/media-groups.controller';
import { ProgramController } from '../../program/program.controller';
import { ScenesController } from '../../scenes/scenes.controller';
import { UNTRUSTED_NOTE } from '../contract';
import { LayoutsMcpTools } from './layouts';
import { MediaGroupsMcpTools } from './media-groups';
import { ProgramMcpTools } from './program';
import { ScenesMcpTools } from './scenes';

// The 47 rows of gaulatti/alcantara#210 appendix A that belong to ticket #216:
// the program routes that are not flight, radio, recording or broadcast (29),
// scenes (9), layouts (5) and media groups (4). Names and tiers are binding; a row that
// looks wrong against the code is reported, never adjusted here.
// area, method, path, permission, handler, capability, tier
const ROWS = `
program	GET	/program	program.read	listPrograms	program_list_programs	R
program	POST	/program/template/inspect	program.manage	inspectTemplate	program_inspect_template	W
program	POST	/program	program.manage	createProgram	program_create_program	W
program	PUT	/program/:programId	program.manage	renameProgram	program_rename_program	W
program	DELETE	/program/:programId	program.manage	deleteProgram	program_delete_program	D
program	PUT	/program/broadcast-settings	program.operate	updateBroadcastSettings	program_update_broadcast_settings	A
program	POST	/program/:programId/scene-instant/take	program.operate	takeProgramSceneInstantById	program_take_program_scene_instant_by_id	A
program	POST	/program/:programId/scene-instant/stop	program.operate	stopProgramSceneInstantById	program_stop_program_scene_instant_by_id	A
program	POST	/program/:programId/song-queue	program.operate	enqueueProgramSongById	program_enqueue_program_song_by_id	A
program	PUT	/program/:programId/song-queue	program.operate	reorderProgramSongQueueById	program_reorder_program_song_queue_by_id	A
program	DELETE	/program/:programId/song-queue/:entryId	program.operate	removeQueuedProgramSongById	program_remove_queued_program_song_by_id	W
program	POST	/program/:programId/scenes	program.manage	addSceneToProgram	program_add_scene_to_program	W
program	DELETE	/program/:programId/scenes/:sceneId	program.manage	removeSceneFromProgram	program_remove_scene_from_program	D
program	POST	/program/:programId/media-groups	program.manage	addMediaGroupToProgram	program_add_media_group_to_program	W
program	DELETE	/program/:programId/media-groups/:mediaGroupId	program.manage	removeMediaGroupFromProgram	program_remove_media_group_from_program	D
program	POST	/program/:programId/stingers	program.manage	addStingerToProgram	program_add_stinger_to_program	W
program	DELETE	/program/:programId/stingers/:stingerId	program.manage	removeStingerFromProgram	program_remove_stinger_from_program	D
program	POST	/program/:programId/activate	program.operate	activateSceneById	program_activate_scene_by_id	A
program	GET	/program/:programId/stage	program.read	getStagedSceneById	program_get_staged_scene_by_id	R
program	POST	/program/:programId/stage	program.operate	stageSceneById	program_stage_scene_by_id	A
program	PUT	/program/:programId/fade-to-black	program.operate	setFadeToBlackById	program_set_fade_to_black_by_id	A
program	POST	/program/:programId/off-air	program.operate	takeProgramOffAirById	program_take_program_off_air_by_id	A
program	POST	/program/:programId/song/off-air	program.operate	takeProgramSongOffAirById	program_take_program_song_off_air_by_id	A
program	POST	/program/:programId/reload	program.operate	reloadProgramById	program_reload_program_by_id	A
program	PUT	/program/:programId/audio-bus	program.operate	updateProgramAudioBusById	program_update_program_audio_bus_by_id	A
program	POST	/program/activate	program.operate	activateScene	program_activate_scene	A
program	POST	/program/off-air	program.operate	takeProgramOffAir	program_take_program_off_air	A
program	POST	/program/song/off-air	program.operate	takeProgramSongOffAir	program_take_program_song_off_air	A
program	POST	/program/reload	program.operate	reloadProgram	program_reload_program	A
scenes	GET	/scenes	scene.read	findAll	scene_find_all	R
scenes	GET	/scenes/:id	scene.read	findOne	scene_find_one	R
scenes	POST	/scenes	scene.manage	create	scene_create	W
scenes	PUT	/scenes/:id	scene.manage	update	scene_update	W
scenes	PUT	/scenes/:id/chyron	scene.operate	updateChyron	scene_update_chyron	A
scenes	POST	/scenes/:id/modo-italiano-bracket/draw	scene.operate	drawModoItalianoBracket	scene_draw_modo_italiano_bracket	A
scenes	POST	/scenes/:id/modo-italiano-bracket/vote	scene.operate	voteModoItalianoBracket	scene_vote_modo_italiano_bracket	A
scenes	POST	/scenes/:id/modo-italiano-bracket/voting/open	scene.operate	openModoItalianoBracketVoting	scene_open_modo_italiano_bracket_voting	A
scenes	DELETE	/scenes/:id	scene.manage	remove	scene_remove	D
layouts	GET	/layouts	layout.read	findAll	layout_find_all	R
layouts	GET	/layouts/:id	layout.read	findOne	layout_find_one	R
layouts	POST	/layouts	layout.manage	create	layout_create	W
layouts	PUT	/layouts/:id	layout.manage	update	layout_update	W
layouts	DELETE	/layouts/:id	layout.manage	remove	layout_remove	D
media-groups	GET	/media-groups	media.read	findAll	media_group_find_all	R
media-groups	POST	/media-groups	media.manage	create	media_group_create	W
media-groups	PUT	/media-groups/:id	media.manage	update	media_group_update	W
media-groups	DELETE	/media-groups/:id	media.manage	remove	media_group_remove	D
`
  .trim()
  .split('\n')
  .map((line) => line.split('\t'));

const permissionOf = (key: string): string => {
  const [group, action] = key.split('.');
  const entry = (ALCANTARA_PERMISSIONS as Record<string, unknown>)[group];
  return typeof entry === 'string'
    ? entry
    : (entry as Record<string, string>)[action];
};

const specs = [
  ...new ProgramMcpTools(
    {} as never,
    {} as never,
    { teamId: 7 } as never,
  ).specs(),
  ...new ScenesMcpTools({} as never, {} as never).specs(),
  ...new LayoutsMcpTools(
    {} as never,
    {} as never,
    { teamId: 7 } as never,
  ).specs(),
  ...new MediaGroupsMcpTools({} as never, {} as never).specs(),
];

describe('appendix A rows of ticket #216', () => {
  it.each(ROWS)(
    '%s %s %s needs %s and is capability %s (tier %s)',
    (_area, _method, _path, permission, _handler, name, tier) => {
      const spec = specs.find((candidate) => candidate.name === name);
      expect(spec).toBeDefined();
      expect(spec?.permission).toBe(permissionOf(permission));
      expect(spec?.tier).toBe(tier);
      expect(spec?.firstClass).toBe(false);
    },
  );

  it.each(ROWS)(
    '%s %s %s: the permission is the one the controller handler requires',
    (area, _method, _path, _permission, handler, name) => {
      const controller = {
        program: ProgramController,
        scenes: ScenesController,
        layouts: LayoutsController,
        'media-groups': MediaGroupsController,
      }[area] as unknown as { prototype: Record<string, unknown> };
      const required =
        (Reflect.getMetadata(
          REQUIRED_PERMISSION_KEY,
          controller.prototype[handler] as object,
        ) as string | undefined) ??
        (Reflect.getMetadata(REQUIRED_PERMISSION_KEY, controller) as string);
      expect(specs.find((spec) => spec.name === name)?.permission).toBe(
        required,
      );
    },
  );

  it('registers exactly those rows, once each', () => {
    expect(specs.map((spec) => spec.name).sort()).toEqual(
      ROWS.map((row) => row[5]).sort(),
    );
  });

  it('has the counted rows per area and tier', () => {
    const count = (area: string) =>
      ROWS.filter((row) => row[0] === area).length;
    expect([
      count('program'),
      count('scenes'),
      count('layouts'),
      count('media-groups'),
    ]).toEqual([29, 9, 5, 4]);
    const tiers = ROWS.map((row) => row[6]);
    for (const [tier, n] of [
      ['R', 7],
      ['W', 13],
      ['A', 20],
      ['D', 7],
    ] as const)
      expect(tiers.filter((t) => t === tier)).toHaveLength(n);
  });

  it('gives every A and D capability a dry run and a confirm target, and every W a dry run', () => {
    for (const spec of specs) {
      expect(spec.dryRun !== undefined).toBe(spec.tier !== 'R');
      expect(spec.confirmTarget !== undefined).toBe(
        spec.tier === 'A' || spec.tier === 'D',
      );
    }
  });

  it('ends every description that carries user text with the untrusted note', () => {
    for (const spec of specs)
      expect(spec.description.endsWith(UNTRUSTED_NOTE)).toBe(true);
  });
});
