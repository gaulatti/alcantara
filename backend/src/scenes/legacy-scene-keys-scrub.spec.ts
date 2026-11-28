// gaulatti/alcantara#391: the scrub removes only the inert legacy chyron and clock keys, and only where their Giorgia
// replacement is present; it refuses anything else, and its revert restores a scene's metadata exactly.
interface ScrubPlan {
  refused?: string;
  nothingToDo?: boolean;
  removed?: string[];
  keysBefore?: string[];
  keysAfter?: string[];
  originalMetadata?: string;
  scrubbedMetadata: string;
  restoredMetadata?: string;
  [field: string]: unknown;
}
interface ScrubModule {
  planSceneScrub(sceneId: number, text: string | null | undefined): ScrubPlan;
  planSceneRevert(input: unknown, ...rest: unknown[]): ScrubPlan;
  hostAllowed(url: string, allow: boolean): boolean;
  SCENE_IDS: number[];
  LEGACY_KEYS: string[];
}
const scrub =
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('../../scripts/scrub-legacy-scene-keys.cjs') as ScrubModule;

const giorgiaClock = { show: true, headline: 'Fictional' };
const legacyChyron = { textSequence: ['legacy'] };

describe('legacy scene key scrub', () => {
  it('removes only the legacy chyron and clock keys, keeping every other key in order', () => {
    const text = JSON.stringify({
      'modoitaliano-chyron': legacyChyron,
      'modoitaliano-giorgia-chyron': { textSequence: ['new'] },
      'modoitaliano-clock': { show: false },
      'modoitaliano-giorgia-clock': giorgiaClock,
      'modoitaliano-bracket': { matches: [] },
    });
    const plan = scrub.planSceneScrub(74, text);
    expect(plan.removed).toEqual(['modoitaliano-chyron', 'modoitaliano-clock']);
    expect(plan.keysBefore).toEqual([
      'modoitaliano-chyron',
      'modoitaliano-giorgia-chyron',
      'modoitaliano-clock',
      'modoitaliano-giorgia-clock',
      'modoitaliano-bracket',
    ]);
    expect(plan.keysAfter).toEqual([
      'modoitaliano-giorgia-chyron',
      'modoitaliano-giorgia-clock',
      'modoitaliano-bracket',
    ]);
    expect(JSON.parse(plan.scrubbedMetadata)).toEqual({
      'modoitaliano-giorgia-chyron': { textSequence: ['new'] },
      'modoitaliano-giorgia-clock': giorgiaClock,
      'modoitaliano-bracket': { matches: [] },
    });
  });

  it('keeps the original metadata text so the revert can restore it exactly', () => {
    const text =
      '{"modoitaliano-clock":{"show":false},"modoitaliano-giorgia-clock":{"show":true}}';
    const plan = scrub.planSceneScrub(35, text);
    expect(plan.originalMetadata).toBe(text);
    const revert = scrub.planSceneRevert(
      {
        sceneId: 35,
        originalMetadata: plan.originalMetadata,
        scrubbedMetadata: plan.scrubbedMetadata,
      },
      plan.scrubbedMetadata,
    );
    expect(revert.restoredMetadata).toBe(text);
    // The revert only writes when the scene still holds the scrubbed text it was made from.
    expect(revert.scrubbedMetadata).toBe(plan.scrubbedMetadata);
  });

  it('does nothing for a scene that has no legacy key', () => {
    const plan = scrub.planSceneScrub(
      11,
      '{"modoitaliano-giorgia-clock":{"show":true}}',
    );
    expect(plan.nothingToDo).toBe(true);
    expect(plan.removed).toEqual([]);
  });

  it('refuses a legacy key whose Giorgia replacement is missing, so no data is dropped', () => {
    const plan = scrub.planSceneScrub(
      40,
      '{"modoitaliano-chyron":{"textSequence":[]}}',
    );
    expect(plan.refused).toMatch(
      /modoitaliano-chyron has no modoitaliano-giorgia-chyron/,
    );
    expect(plan.removed).toBeUndefined();
  });

  it('refuses a scene outside the expected list, missing metadata, non-JSON metadata, and a non-object', () => {
    expect(scrub.planSceneScrub(12, '{}').refused).toMatch(
      /not one of the expected scenes/,
    );
    expect(scrub.planSceneScrub(39, null).refused).toMatch(/no metadata/);
    expect(scrub.planSceneScrub(39, '{not json').refused).toMatch(/not JSON/);
    expect(scrub.planSceneScrub(39, '[1,2]').refused).toMatch(
      /not a JSON object/,
    );
  });

  it('refuses a revert onto a scene that changed since the scrub', () => {
    const revert = scrub.planSceneRevert(
      {
        sceneId: 65,
        originalMetadata:
          '{"modoitaliano-clock":{}, "modoitaliano-giorgia-clock":{}}',
        scrubbedMetadata: '{"modoitaliano-giorgia-clock":{}}',
      },
      '{"modoitaliano-giorgia-clock":{},"edited":true}',
    );
    expect(revert.refused).toMatch(/changed since the scrub/);
    expect(revert.restoredMetadata).toBeUndefined();
  });

  it('expects exactly the ten scenes named in the closer, and the two legacy keys', () => {
    expect(scrub.SCENE_IDS).toEqual([11, 35, 36, 39, 40, 41, 65, 74, 75, 79]);
    expect(scrub.LEGACY_KEYS).toEqual([
      'modoitaliano-chyron',
      'modoitaliano-clock',
    ]);
  });

  it('refuses a database host that is not local unless told otherwise', () => {
    expect(scrub.hostAllowed('postgres://u:p@localhost:5432/db', false)).toBe(
      true,
    );
    expect(
      scrub.hostAllowed('postgres://u:p@db.example.com:5432/db', false),
    ).toBe(false);
    expect(
      scrub.hostAllowed('postgres://u:p@db.example.com:5432/db', true),
    ).toBe(true);
  });
});
