import { ALCANTARA_PERMISSIONS } from '../../auth/permissions';
import { UNTRUSTED_NOTE } from '../contract';
import { LayoutsMcpTools } from './layouts';
import { MediaGroupsMcpTools } from './media-groups';
import { ProgramMcpTools } from './program';
import { ScenesMcpTools } from './scenes';

// The rows of gaulatti/alcantara#210 appendix A that belong to ticket #216:
// the program routes that are not flight, radio, recording or broadcast,
// scenes, layouts and media groups. Names and tiers are binding; a row that
// looks wrong against the code is reported, never adjusted here.
// area, method, path, permission, handler, capability, tier
const ROWS = `
program	GET	/program	program.read	listPrograms	program_list_programs	R
program	GET	/program/:programId/stage	program.read	getStagedSceneById	program_get_staged_scene_by_id	R
scenes	GET	/scenes	scene.read	findAll	scene_find_all	R
scenes	GET	/scenes/:id	scene.read	findOne	scene_find_one	R
layouts	GET	/layouts	layout.read	findAll	layout_find_all	R
layouts	GET	/layouts/:id	layout.read	findOne	layout_find_one	R
media-groups	GET	/media-groups	media.read	findAll	media_group_find_all	R
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
  ...new ProgramMcpTools({} as never).specs(),
  ...new ScenesMcpTools({} as never).specs(),
  ...new LayoutsMcpTools({} as never).specs(),
  ...new MediaGroupsMcpTools({} as never).specs(),
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

  it('registers exactly those rows, once each', () => {
    expect(specs.map((spec) => spec.name).sort()).toEqual(
      ROWS.map((row) => row[5]).sort(),
    );
  });

  it('ends every description that carries user text with the untrusted note', () => {
    for (const spec of specs)
      expect(spec.description.endsWith(UNTRUSTED_NOTE)).toBe(true);
  });
});
