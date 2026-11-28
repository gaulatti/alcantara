#!/usr/bin/env node
// gaulatti/alcantara#391: remove the dead `tournament-bracket` element from layout 2236 (MI-Mundial) and its key from
// scene 74. Nothing registers that id in Alcántara, Giorgia or any modoitaliano repo, so it draws nothing. Only that element
// and that key are removed; the other elements of the list keep their order, and the scene's other keys are untouched.
// The original layout componentType and scene metadata text are saved to a backup file first, so --revert restores each
// exactly (the element goes back to its original position).
//
//   node scripts/remove-tournament-bracket.cjs                       # dry run (default): prints the before and after
//   node scripts/remove-tournament-bracket.cjs --apply --backup FILE # writes the backup, then both changes in one transaction
//   node scripts/remove-tournament-bracket.cjs --revert --backup FILE # restores both from the backup, in one transaction
//
// DATABASE_URL names the database. A host other than localhost, 127.0.0.1 or postgres is refused unless --allow-remote is
// given. The script prints key and element names only, never values. It refuses anything it does not expect: a layout that
// is not MI-Mundial, a list with the element absent or twice, a scene that is missing, metadata that is not a JSON object,
// a tournament-bracket key whose value is not an object, and a revert onto a row that changed since the apply.

const fs = require('node:fs');

const LAYOUT = { id: 2236, name: 'MI-Mundial' };
const SCENE_ID = 74;
const ELEMENT = 'tournament-bracket';
const KEY = 'tournament-bracket';

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Removes the one exact element from a comma-separated list; refuses if it is absent or present more than once. */
function removeListElement(list) {
  const elements = list.split(',');
  const count = elements.filter((element) => element === ELEMENT).length;
  if (count === 0) return { alreadyRemoved: true };
  if (count > 1) return { refused: `${ELEMENT} appears ${count} times in the list` };
  const index = elements.indexOf(ELEMENT);
  const next = elements.filter((element) => element !== ELEMENT);
  return { value: next.join(','), index };
}

/** Puts the element back at its original index in a list that no longer holds it. */
function insertListElement(list, index) {
  const elements = list === '' ? [] : list.split(',');
  if (elements.includes(ELEMENT)) return { refused: `${ELEMENT} is already in the list` };
  elements.splice(index, 0, ELEMENT);
  return { value: elements.join(',') };
}

/** Plans the removal for the layout row. Pure. */
function planLayout(layout) {
  if (layout.id !== LAYOUT.id || layout.name !== LAYOUT.name) {
    return { refused: `layout ${layout.id} is not ${LAYOUT.name}` };
  }
  if (typeof layout.componentType !== 'string') return { refused: 'layout componentType is not text' };
  const removal = removeListElement(layout.componentType);
  if (removal.refused) return { refused: `layout componentType: ${removal.refused}` };
  if (removal.alreadyRemoved) return { alreadyRemoved: true };
  return { componentTypeBefore: layout.componentType, componentTypeAfter: removal.value, index: removal.index };
}

/** Plans the removal of the key from scene 74's metadata. Pure. */
function planScene(sceneId, metadataText) {
  if (sceneId !== SCENE_ID) return { sceneId, refused: `scene ${sceneId} is not scene ${SCENE_ID}` };
  if (metadataText === null || metadataText === undefined) return { sceneId, refused: 'scene has no metadata' };
  let metadata;
  try {
    metadata = JSON.parse(metadataText);
  } catch {
    return { sceneId, refused: 'scene metadata is not JSON' };
  }
  if (!isPlainObject(metadata)) return { sceneId, refused: 'scene metadata is not a JSON object' };
  if (!Object.prototype.hasOwnProperty.call(metadata, KEY)) return { sceneId, alreadyRemoved: true };
  if (!isPlainObject(metadata[KEY])) return { sceneId, refused: `${KEY} is not an object; nothing is guessed` };
  const next = {};
  for (const [key, value] of Object.entries(metadata)) if (key !== KEY) next[key] = value;
  return {
    sceneId,
    keysBefore: Object.keys(metadata),
    keysAfter: Object.keys(next),
    originalMetadata: metadataText,
    scrubbedMetadata: JSON.stringify(next),
  };
}

/** Plans the revert from a backup entry, refusing a row changed since the apply. */
function planRevert(entry, currentListText, currentMetadataText) {
  if (currentListText !== entry.scrubbedComponentType) return { refused: 'layout changed since the removal; restore it by hand' };
  if (currentMetadataText !== entry.scrubbedMetadata) return { refused: `scene ${SCENE_ID} changed since the removal; restore it by hand` };
  return { restoredComponentType: entry.originalComponentType, restoredMetadata: entry.originalMetadata };
}

function describe(plan) {
  if (plan.refused) return [`REFUSED: ${plan.refused}`];
  if (plan.alreadyRemoved) return [`${plan.sceneId ? `scene ${plan.sceneId}` : 'layout'}: ${ELEMENT} already absent, no change`];
  return [];
}

function hostAllowed(url, allowRemote) {
  const host = new URL(url).hostname;
  return allowRemote || ['localhost', '127.0.0.1', 'postgres'].includes(host);
}

function argValue(argv, name) {
  const index = argv.indexOf(name);
  return index === -1 ? null : argv[index + 1] ?? null;
}

async function main(argv = process.argv.slice(2)) {
  const mode = argv.includes('--revert') ? 'revert' : argv.includes('--apply') ? 'apply' : 'dry-run';
  const allowRemote = argv.includes('--allow-remote');
  const backupPath = argValue(argv, '--backup');
  if (mode !== 'dry-run' && !backupPath) throw new Error('--backup FILE is required with --apply or --revert');
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  if (!hostAllowed(url, allowRemote)) {
    throw new Error(`refusing to write to host ${new URL(url).hostname}; pass --allow-remote only for the database you mean`);
  }
  const { Client } = require('pg');
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    console.log(`mode: ${mode} (${mode === 'dry-run' ? 'no writes' : 'writes in one transaction'})`);
    const { rows: [layout] } = await client.query('SELECT id, name, "componentType" FROM "Layout" WHERE id = $1', [LAYOUT.id]);
    const { rows: [scene] } = await client.query('SELECT id, metadata FROM "Scene" WHERE id = $1', [SCENE_ID]);
    if (mode === 'revert') {
      const backup = JSON.parse(fs.readFileSync(backupPath, 'utf8'));
      if (!layout || !scene) throw new Error('layout or scene not found; nothing written');
      const plan = planRevert(backup, layout.componentType, scene.metadata);
      if (plan.refused) throw new Error(`revert refused: ${plan.refused}; nothing written`);
      console.log(`layout ${LAYOUT.id}: restore componentType`);
      console.log(`scene ${SCENE_ID}: restore metadata keys`);
      await client.query('BEGIN');
      try {
        const layoutResult = await client.query('UPDATE "Layout" SET "componentType" = $1, "updatedAt" = now() WHERE id = $2 AND "componentType" = $3', [plan.restoredComponentType, LAYOUT.id, backup.scrubbedComponentType]);
        const sceneResult = await client.query('UPDATE "Scene" SET metadata = $1, "updatedAt" = now() WHERE id = $2 AND metadata = $3', [plan.restoredMetadata, SCENE_ID, backup.scrubbedMetadata]);
        if (layoutResult.rowCount !== 1 || sceneResult.rowCount !== 1) throw new Error('a row changed during revert; nothing committed');
        await client.query('COMMIT');
        console.log('committed');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
      return;
    }
    if (!layout) throw new Error(`layout ${LAYOUT.id} not found; nothing written`);
    const layoutPlan = planLayout(layout);
    const scenePlan = scene ? planScene(SCENE_ID, scene.metadata) : { sceneId: SCENE_ID, refused: `scene ${SCENE_ID} not found` };
    const lines = [];
    if (layoutPlan.refused) lines.push(`layout ${LAYOUT.id}: ${describe(layoutPlan)[0]}`);
    else if (layoutPlan.alreadyRemoved) lines.push(`layout ${LAYOUT.id}: ${ELEMENT} already absent, no change`);
    else lines.push(`layout ${LAYOUT.id}: componentType`, `  before: ${layoutPlan.componentTypeBefore}`, `  after:  ${layoutPlan.componentTypeAfter}`);
    if (scenePlan.refused) lines.push(`scene ${SCENE_ID}: REFUSED: ${scenePlan.refused}`);
    else if (scenePlan.alreadyRemoved) lines.push(`scene ${SCENE_ID}: ${KEY} already absent, no change`);
    else lines.push(`scene ${SCENE_ID}: remove key ${KEY}`, `  keys before: [${scenePlan.keysBefore.join(', ')}]`, `  keys after:  [${scenePlan.keysAfter.join(', ')}]`);
    for (const line of lines) console.log(line);
    if (layoutPlan.refused || scenePlan.refused) throw new Error('removal refused; nothing written');
    if (mode === 'dry-run') return;
    if (layoutPlan.alreadyRemoved && scenePlan.alreadyRemoved) {
      console.log('nothing to apply');
      return;
    }
    if (fs.existsSync(backupPath)) throw new Error(`backup ${backupPath} already exists; choose a new file`);
    const backup = {
      createdAt: new Date().toISOString(),
      originalComponentType: layout.componentType,
      scrubbedComponentType: layoutPlan.componentTypeAfter ?? layout.componentType,
      originalMetadata: scene.metadata,
      scrubbedMetadata: scenePlan.scrubbedMetadata ?? scene.metadata,
    };
    fs.writeFileSync(backupPath, JSON.stringify(backup, null, 2), { flag: 'wx' });
    console.log(`backup written: ${backupPath}`);
    await client.query('BEGIN');
    try {
      if (!layoutPlan.alreadyRemoved) {
        const result = await client.query('UPDATE "Layout" SET "componentType" = $1, "updatedAt" = now() WHERE id = $2 AND "componentType" = $3', [layoutPlan.componentTypeAfter, LAYOUT.id, layout.componentType]);
        if (result.rowCount !== 1) throw new Error('layout changed during apply; nothing committed');
      }
      if (!scenePlan.alreadyRemoved) {
        const result = await client.query('UPDATE "Scene" SET metadata = $1, "updatedAt" = now() WHERE id = $2 AND metadata = $3', [scenePlan.scrubbedMetadata, SCENE_ID, scene.metadata]);
        if (result.rowCount !== 1) throw new Error('scene changed during apply; nothing committed');
      }
      await client.query('COMMIT');
      console.log('committed');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  } finally {
    await client.end();
  }
}

module.exports = { removeListElement, insertListElement, planLayout, planScene, planRevert, hostAllowed, ELEMENT, KEY, LAYOUT, SCENE_ID };

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
