#!/usr/bin/env node
// gaulatti/alcantara#391: remove the inert legacy Modo Italiano chyron and clock keys from the scene metadata.
//
// The scenes below carry `modoitaliano-chyron` and/or `modoitaliano-clock` props next to the Giorgia keys their layouts
// actually place. The legacy keys are read by nothing, so removing them changes no output. Only these two keys are
// removed, only on these scenes, and the original metadata of each scene is saved to a backup file first, so --revert
// restores each scene's metadata exactly as it was.
//
//   node scripts/scrub-legacy-scene-keys.cjs                          # dry run (default): prints before and after
//   node scripts/scrub-legacy-scene-keys.cjs --apply --backup FILE    # writes the backup, then all changes in one transaction
//   node scripts/scrub-legacy-scene-keys.cjs --revert --backup FILE   # restores each scene from the backup, in one transaction
//
// DATABASE_URL names the database. A host other than localhost, 127.0.0.1 or postgres is refused unless --allow-remote is
// given. The script prints key names only, never values. It refuses anything it does not expect: a scene that is missing,
// metadata that is not a JSON object, a legacy key with no matching Giorgia key, a backup that does not match the scene
// as it now stands, and a revert onto a scene that changed since the apply.

const fs = require('node:fs');

const SCENE_IDS = [11, 35, 36, 39, 40, 41, 65, 74, 75, 79];
const LEGACY_KEYS = ['modoitaliano-chyron', 'modoitaliano-clock'];
// A legacy key is only removed when its Giorgia replacement is present, so no data is ever dropped.
const REPLACEMENT = { 'modoitaliano-chyron': 'modoitaliano-giorgia-chyron', 'modoitaliano-clock': 'modoitaliano-giorgia-clock' };

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * Plans the scrub for one scene. Pure. Returns `{ sceneId, refused }` when the scene cannot be changed safely,
 * `{ sceneId, removed: [], ... }` when it has nothing to remove, or the removal with the metadata before and after.
 */
function planSceneScrub(sceneId, metadataText) {
  if (!SCENE_IDS.includes(sceneId)) return { sceneId, refused: 'scene is not one of the expected scenes' };
  if (metadataText === null || metadataText === undefined) return { sceneId, refused: 'scene has no metadata' };
  let metadata;
  try {
    metadata = JSON.parse(metadataText);
  } catch {
    return { sceneId, refused: 'scene metadata is not JSON' };
  }
  if (!isPlainObject(metadata)) return { sceneId, refused: 'scene metadata is not a JSON object' };
  const removed = [];
  for (const key of LEGACY_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(metadata, key)) continue;
    if (!Object.prototype.hasOwnProperty.call(metadata, REPLACEMENT[key])) {
      return { sceneId, refused: `${key} has no ${REPLACEMENT[key]} to keep its data` };
    }
    removed.push(key);
  }
  if (removed.length === 0) return { sceneId, removed, nothingToDo: true };
  const next = {};
  for (const [key, value] of Object.entries(metadata)) if (!removed.includes(key)) next[key] = value;
  return {
    sceneId,
    removed,
    keysBefore: Object.keys(metadata),
    keysAfter: Object.keys(next),
    originalMetadata: metadataText,
    scrubbedMetadata: JSON.stringify(next),
  };
}

/** Plans the revert for one scene from its backup entry, refusing a scene that changed since the apply. */
function planSceneRevert(entry, currentMetadataText) {
  if (currentMetadataText !== entry.scrubbedMetadata) {
    return { sceneId: entry.sceneId, refused: 'scene changed since the scrub; restore it by hand' };
  }
  return {
    sceneId: entry.sceneId,
    scrubbedMetadata: entry.scrubbedMetadata,
    restoredMetadata: entry.originalMetadata,
    keysAfter: Object.keys(JSON.parse(entry.originalMetadata)),
  };
}

function describePlan(plan) {
  if (plan.refused) return [`scene ${plan.sceneId}: REFUSED: ${plan.refused}`];
  if (plan.nothingToDo) return [`scene ${plan.sceneId}: no legacy key present, no change`];
  if (plan.restoredMetadata !== undefined) return [`scene ${plan.sceneId}: restore keys [${plan.keysAfter.join(', ')}]`];
  return [
    `scene ${plan.sceneId}: remove [${plan.removed.join(', ')}]`,
    `  keys before: [${plan.keysBefore.join(', ')}]`,
    `  keys after:  [${plan.keysAfter.join(', ')}]`,
  ];
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
    if (mode === 'revert') {
      const backup = JSON.parse(fs.readFileSync(backupPath, 'utf8'));
      const plans = [];
      for (const entry of backup.scenes) {
        const { rows: [row] } = await client.query('SELECT id, metadata FROM "Scene" WHERE id = $1', [entry.sceneId]);
        plans.push(row ? planSceneRevert(entry, row.metadata) : { sceneId: entry.sceneId, refused: 'scene not found' });
      }
      for (const plan of plans) for (const line of describePlan(plan)) console.log(line);
      if (plans.some((plan) => plan.refused)) throw new Error('revert refused; nothing written');
      await client.query('BEGIN');
      try {
        for (const plan of plans) {
          const result = await client.query('UPDATE "Scene" SET metadata = $1, "updatedAt" = now() WHERE id = $2 AND metadata = $3', [plan.restoredMetadata, plan.sceneId, plan.scrubbedMetadata]);
          if (result.rowCount !== 1) throw new Error(`scene ${plan.sceneId} changed during revert; nothing committed`);
        }
        await client.query('COMMIT');
        console.log('committed');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
      return;
    }
    const { rows } = await client.query('SELECT id, metadata FROM "Scene" WHERE id = ANY($1::int[]) ORDER BY id', [SCENE_IDS]);
    const byId = new Map(rows.map((row) => [row.id, row]));
    const plans = SCENE_IDS.map((sceneId) => {
      const row = byId.get(sceneId);
      return row ? planSceneScrub(sceneId, row.metadata) : { sceneId, refused: 'scene not found' };
    });
    for (const plan of plans) for (const line of describePlan(plan)) console.log(line);
    if (plans.some((plan) => plan.refused)) throw new Error('scrub refused; nothing written');
    if (mode === 'dry-run') return;
    const changes = plans.filter((plan) => plan.removed.length > 0);
    if (changes.length === 0) {
      console.log('nothing to apply: no legacy key is present on the ten scenes');
      return;
    }
    const backup = {
      createdAt: new Date().toISOString(),
      scenes: changes.map((plan) => ({ sceneId: plan.sceneId, originalMetadata: plan.originalMetadata, scrubbedMetadata: plan.scrubbedMetadata })),
    };
    if (fs.existsSync(backupPath)) throw new Error(`backup ${backupPath} already exists; choose a new file`);
    fs.writeFileSync(backupPath, JSON.stringify(backup, null, 2), { flag: 'wx' });
    console.log(`backup written: ${backupPath} (${backup.scenes.length} scenes)`);
    await client.query('BEGIN');
    try {
      for (const plan of changes) {
        const result = await client.query('UPDATE "Scene" SET metadata = $1, "updatedAt" = now() WHERE id = $2 AND metadata = $3', [plan.scrubbedMetadata, plan.sceneId, plan.originalMetadata]);
        if (result.rowCount !== 1) throw new Error(`scene ${plan.sceneId} changed during apply; nothing committed`);
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

module.exports = { planSceneScrub, planSceneRevert, describePlan, hostAllowed, SCENE_IDS, LEGACY_KEYS, REPLACEMENT };

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
