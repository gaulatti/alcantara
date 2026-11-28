// gaulatti/alcantara#391: the bracket id migration plans only the change it names, refuses a row it cannot move safely,
// and reverses cleanly. The planner is a plain module under scripts/, loaded the same way the other scripts are.
interface BracketPlan {
  refused?: string;
  layoutChange?: { componentTypeBefore: string; componentTypeAfter: string };
  sceneChanges: Array<{
    keysBefore?: string[];
    keysAfter?: string[];
    metadataAfter: string;
  }>;
  alreadyApplied?: boolean;
  [field: string]: unknown;
}
interface BracketMigration {
  planBracketMigration(input: unknown): BracketPlan;
  replaceListElement(
    list: string,
    from: string,
    to: string,
  ): { refused?: string; [field: string]: unknown };
  hostAllowed(url: string, allow: boolean): boolean;
}
const migration =
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('../../scripts/migrate-bracket-component.cjs') as BracketMigration;

const layout = {
  id: 2236,
  name: 'MI-Mundial',
  componentType: 'modoitaliano-bracket',
};
const scene = (id: number, metadata: Record<string, unknown>) => ({
  id,
  metadata: JSON.stringify(metadata),
});

// The real value of layout 2236 on production (dry run, 23:50 UTC): componentType is a comma-separated list.
const REAL_LIST =
  'modoitaliano-giorgia-clock,tournament-bracket,modoitaliano-bracket,slideshow';
const REAL_LIST_MIGRATED =
  'modoitaliano-giorgia-clock,tournament-bracket,modoitaliano-giorgia-bracket,slideshow';

describe('bracket component migration', () => {
  it('replaces only the exact bracket element of the real comma-separated list, keeping order and the other elements', () => {
    const plan = migration.planBracketMigration({
      direction: 'apply',
      layout: { id: 2236, name: 'MI-Mundial', componentType: REAL_LIST },
      scenes: [scene(74, { 'modoitaliano-bracket': { matches: [] } })],
    });
    expect(plan.refused).toBeUndefined();
    expect(plan.layoutChange).toEqual({
      componentTypeBefore: REAL_LIST,
      componentTypeAfter: REAL_LIST_MIGRATED,
    });
  });

  it('reverts the real list back to the legacy element at the same position', () => {
    const plan = migration.planBracketMigration({
      direction: 'revert',
      layout: {
        id: 2236,
        name: 'MI-Mundial',
        componentType: REAL_LIST_MIGRATED,
      },
      scenes: [scene(74, { 'modoitaliano-giorgia-bracket': { matches: [] } })],
    });
    expect(plan.layoutChange).toEqual({
      componentTypeBefore: REAL_LIST_MIGRATED,
      componentTypeAfter: REAL_LIST,
    });
  });

  it('refuses a list with no bracket element, one with the bracket twice, and a lookalike that is only a substring', () => {
    const absent = migration.planBracketMigration({
      direction: 'apply',
      layout: {
        id: 2236,
        name: 'MI-Mundial',
        componentType: 'modoitaliano-giorgia-clock,slideshow',
      },
      scenes: [],
    });
    expect(absent.refused).toMatch(/no modoitaliano-bracket element/);
    const twice = migration.planBracketMigration({
      direction: 'apply',
      layout: {
        id: 2236,
        name: 'MI-Mundial',
        componentType: 'modoitaliano-bracket,x,modoitaliano-bracket',
      },
      scenes: [],
    });
    expect(twice.refused).toMatch(/appears 2 times/);
    const lookalike = migration.planBracketMigration({
      direction: 'apply',
      layout: {
        id: 2236,
        name: 'MI-Mundial',
        componentType: 'my-modoitaliano-bracket-v2,slideshow',
      },
      scenes: [],
    });
    expect(lookalike.refused).toMatch(/no modoitaliano-bracket element/);
  });

  it('treats a list already on the Giorgia element as applied', () => {
    const plan = migration.planBracketMigration({
      direction: 'apply',
      layout: {
        id: 2236,
        name: 'MI-Mundial',
        componentType: REAL_LIST_MIGRATED,
      },
      scenes: [],
    });
    expect(plan.alreadyApplied).toBe(true);
  });

  it('refuses to move the legacy element onto a list that already has the Giorgia element', () => {
    expect(
      migration.replaceListElement(
        'a,modoitaliano-giorgia-bracket,modoitaliano-bracket',
        'modoitaliano-bracket',
        'modoitaliano-giorgia-bracket',
      ).refused,
    ).toMatch(/already in the list/);
  });
  it('moves the layout and the scene key to the Giorgia id, keeping the other keys in order', () => {
    const plan = migration.planBracketMigration({
      direction: 'apply',
      layout,
      scenes: [
        scene(74, {
          'modoitaliano-bracket': { matches: [] },
          'modoitaliano-giorgia-clock': { show: true },
        }),
      ],
    });
    expect(plan.layoutChange).toEqual({
      componentTypeBefore: 'modoitaliano-bracket',
      componentTypeAfter: 'modoitaliano-giorgia-bracket',
    });
    expect(plan.sceneChanges).toHaveLength(1);
    expect(plan.sceneChanges[0].keysBefore).toEqual([
      'modoitaliano-bracket',
      'modoitaliano-giorgia-clock',
    ]);
    expect(plan.sceneChanges[0].keysAfter).toEqual([
      'modoitaliano-giorgia-bracket',
      'modoitaliano-giorgia-clock',
    ]);
    expect(JSON.parse(plan.sceneChanges[0].metadataAfter)).toEqual({
      'modoitaliano-giorgia-bracket': { matches: [] },
      'modoitaliano-giorgia-clock': { show: true },
    });
  });

  it('reverts the same change exactly', () => {
    const applied = migration.planBracketMigration({
      direction: 'apply',
      layout,
      scenes: [scene(74, { 'modoitaliano-bracket': { matches: [1] } })],
    });
    const reverted = migration.planBracketMigration({
      direction: 'revert',
      layout: { ...layout, componentType: 'modoitaliano-giorgia-bracket' },
      scenes: [scene(74, JSON.parse(applied.sceneChanges[0].metadataAfter))],
    });
    expect(reverted.layoutChange).toEqual({
      componentTypeBefore: 'modoitaliano-giorgia-bracket',
      componentTypeAfter: 'modoitaliano-bracket',
    });
    expect(JSON.parse(reverted.sceneChanges[0].metadataAfter)).toEqual({
      'modoitaliano-bracket': { matches: [1] },
    });
  });

  it('does nothing when the layout is already on the target id', () => {
    const plan = migration.planBracketMigration({
      direction: 'apply',
      layout: { ...layout, componentType: 'modoitaliano-giorgia-bracket' },
      scenes: [scene(74, { 'modoitaliano-giorgia-bracket': {} })],
    });
    expect(plan.alreadyApplied).toBe(true);
    expect(plan.sceneChanges).toEqual([]);
  });

  it('refuses a layout it does not name, a componentType it does not expect, and a scene that already has the target key', () => {
    expect(
      migration.planBracketMigration({
        direction: 'apply',
        layout: { ...layout, name: 'Other' },
        scenes: [],
      }).refused,
    ).toMatch(/not MI-Mundial/);
    expect(
      migration.planBracketMigration({
        direction: 'apply',
        layout: { ...layout, componentType: 'modoitaliano-chyron' },
        scenes: [],
      }).refused,
    ).toMatch(/no modoitaliano-bracket element/);
    const clash = migration.planBracketMigration({
      direction: 'apply',
      layout,
      scenes: [
        scene(74, {
          'modoitaliano-bracket': {},
          'modoitaliano-giorgia-bracket': {},
        }),
      ],
    });
    expect(clash.refused).toMatch(
      /already has a modoitaliano-giorgia-bracket key/,
    );
    expect(clash.layoutChange).toBeUndefined();
  });

  it('refuses scene metadata that is not JSON rather than guessing', () => {
    const plan = migration.planBracketMigration({
      direction: 'apply',
      layout,
      scenes: [{ id: 74, metadata: '{not json' }],
    });
    expect(plan.refused).toMatch(/scene 74 metadata is not JSON/);
  });

  it('refuses a database host that is not local unless told otherwise', () => {
    expect(
      migration.hostAllowed('postgres://u:p@localhost:5432/db', false),
    ).toBe(true);
    expect(
      migration.hostAllowed('postgres://u:p@postgres:5432/db', false),
    ).toBe(true);
    expect(
      migration.hostAllowed('postgres://u:p@db.example.com:5432/db', false),
    ).toBe(false);
    expect(
      migration.hostAllowed('postgres://u:p@db.example.com:5432/db', true),
    ).toBe(true);
  });
});
