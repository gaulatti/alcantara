// gaulatti/alcantara#391: the bracket id migration plans only the change it names, refuses a row it cannot move safely,
// and reverses cleanly. The planner is a plain module under scripts/, loaded the same way the other scripts are.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const migration = require('../../scripts/migrate-bracket-component.cjs');

const layout = { id: 2236, name: 'MI-Mundial', componentType: 'modoitaliano-bracket' };
const scene = (id: number, metadata: Record<string, unknown>) => ({ id, metadata: JSON.stringify(metadata) });

describe('bracket component migration', () => {
  it('moves the layout and the scene key to the Giorgia id, keeping the other keys in order', () => {
    const plan = migration.planBracketMigration({
      direction: 'apply',
      layout,
      scenes: [scene(74, { 'modoitaliano-bracket': { matches: [] }, 'modoitaliano-giorgia-clock': { show: true } })],
    });
    expect(plan.layoutChange).toEqual({ componentTypeBefore: 'modoitaliano-bracket', componentTypeAfter: 'modoitaliano-giorgia-bracket' });
    expect(plan.sceneChanges).toHaveLength(1);
    expect(plan.sceneChanges[0].keysBefore).toEqual(['modoitaliano-bracket', 'modoitaliano-giorgia-clock']);
    expect(plan.sceneChanges[0].keysAfter).toEqual(['modoitaliano-giorgia-bracket', 'modoitaliano-giorgia-clock']);
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
    expect(reverted.layoutChange).toEqual({ componentTypeBefore: 'modoitaliano-giorgia-bracket', componentTypeAfter: 'modoitaliano-bracket' });
    expect(JSON.parse(reverted.sceneChanges[0].metadataAfter)).toEqual({ 'modoitaliano-bracket': { matches: [1] } });
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
    expect(migration.planBracketMigration({ direction: 'apply', layout: { ...layout, name: 'Other' }, scenes: [] }).refused).toMatch(/not MI-Mundial/);
    expect(migration.planBracketMigration({ direction: 'apply', layout: { ...layout, componentType: 'modoitaliano-chyron' }, scenes: [] }).refused).toMatch(/expected modoitaliano-bracket/);
    const clash = migration.planBracketMigration({
      direction: 'apply',
      layout,
      scenes: [scene(74, { 'modoitaliano-bracket': {}, 'modoitaliano-giorgia-bracket': {} })],
    });
    expect(clash.refused).toMatch(/already has a modoitaliano-giorgia-bracket key/);
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
    expect(migration.hostAllowed('postgres://u:p@localhost:5432/db', false)).toBe(true);
    expect(migration.hostAllowed('postgres://u:p@postgres:5432/db', false)).toBe(true);
    expect(migration.hostAllowed('postgres://u:p@db.example.com:5432/db', false)).toBe(false);
    expect(migration.hostAllowed('postgres://u:p@db.example.com:5432/db', true)).toBe(true);
  });
});
