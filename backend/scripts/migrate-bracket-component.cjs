#!/usr/bin/env node
// gaulatti/alcantara#391: move the Modo Italiano tournament bracket onto Giorgia's id.
//
// Layout 2236 (MI-Mundial) places the bracket as `modoitaliano-bracket`; its scene (74) keeps the bracket's props under
// that key. The bracket already renders Giorgia's component, so the change is the id only: the layout's componentType
// and the scene metadata key move to `modoitaliano-giorgia-bracket`. The backend's draw, vote and open routes accept any
// id that contains "bracket", so they keep working on the new id.
//
// Layout 2237 (MI-Podcast) is not changed: its componentType `modoitaliano-podcast-player` already renders Bleecker's
// PodcastPlayer in the program output (frontend/app/routes/program.tsx), so there is nothing to move.
//
//   node scripts/migrate-bracket-component.cjs                # dry run (default): prints the before and after
//   node scripts/migrate-bracket-component.cjs --apply        # writes, in one transaction
//   node scripts/migrate-bracket-component.cjs --revert       # moves the layout and scene back, in one transaction
//
// DATABASE_URL names the database. A host other than localhost, 127.0.0.1 or postgres is refused unless --allow-remote
// is given, so a production database is never written by accident. The script prints scene metadata keys only, never
// values.

const LEGACY = 'modoitaliano-bracket';
const GIORGIA = 'modoitaliano-giorgia-bracket';
const MIGRATED_LAYOUTS = [{ id: 2236, name: 'MI-Mundial' }];
const UNCHANGED_LAYOUTS = [{ id: 2237, name: 'MI-Podcast', componentType: 'modoitaliano-podcast-player' }];

/** Renames one key of a JSON object, keeping every other key in its place. */
function renameKey(object, from, to) {
  const out = {};
  for (const [key, value] of Object.entries(object)) out[key === from ? to : key] = value;
  return out;
}

/**
 * Plans one direction for one layout. Pure: it reads the rows it is given and writes nothing. A plan that cannot be
 * applied safely comes back with `refused` set and no changes.
 */
function planBracketMigration({ direction, layout, scenes }) {
  const from = direction === 'apply' ? LEGACY : GIORGIA;
  const to = direction === 'apply' ? GIORGIA : LEGACY;
  const expected = MIGRATED_LAYOUTS.find((entry) => entry.id === layout.id);
  if (!expected || layout.name !== expected.name) {
    return { layoutId: layout.id, refused: `layout ${layout.id} is not ${expected ? expected.name : 'a bracket layout'}` };
  }
  if (layout.componentType === to) {
    return { layoutId: layout.id, alreadyApplied: true, layoutChange: null, sceneChanges: [] };
  }
  if (layout.componentType !== from) {
    return { layoutId: layout.id, refused: `layout componentType is ${layout.componentType}, expected ${from}` };
  }
  const sceneChanges = [];
  for (const scene of scenes) {
    let metadata = {};
    try {
      metadata = scene.metadata ? JSON.parse(scene.metadata) : {};
    } catch {
      return { layoutId: layout.id, refused: `scene ${scene.id} metadata is not JSON` };
    }
    if (!Object.prototype.hasOwnProperty.call(metadata, from)) continue;
    if (Object.prototype.hasOwnProperty.call(metadata, to)) {
      return { layoutId: layout.id, refused: `scene ${scene.id} already has a ${to} key; resolve it by hand` };
    }
    const next = renameKey(metadata, from, to);
    sceneChanges.push({
      sceneId: scene.id,
      keysBefore: Object.keys(metadata),
      keysAfter: Object.keys(next),
      metadataAfter: JSON.stringify(next),
    });
  }
  return {
    layoutId: layout.id,
    layoutChange: { componentTypeBefore: from, componentTypeAfter: to },
    sceneChanges,
  };
}

function describePlan(plan, layoutName) {
  const lines = [];
  if (plan.refused) return [`layout ${plan.layoutId} (${layoutName}): REFUSED: ${plan.refused}`];
  if (plan.alreadyApplied) return [`layout ${plan.layoutId} (${layoutName}): already on the target id, no change`];
  lines.push(`layout ${plan.layoutId} (${layoutName}): componentType ${plan.layoutChange.componentTypeBefore} -> ${plan.layoutChange.componentTypeAfter}`);
  if (plan.sceneChanges.length === 0) lines.push('  no scene metadata key to move');
  for (const change of plan.sceneChanges) {
    lines.push(`  scene ${change.sceneId} metadata keys before: [${change.keysBefore.join(', ')}]`);
    lines.push(`  scene ${change.sceneId} metadata keys after:  [${change.keysAfter.join(', ')}]`);
  }
  return lines;
}

function hostAllowed(url, allowRemote) {
  const host = new URL(url).hostname;
  return allowRemote || ['localhost', '127.0.0.1', 'postgres'].includes(host);
}

async function main(argv = process.argv.slice(2)) {
  const mode = argv.includes('--revert') ? 'revert' : argv.includes('--apply') ? 'apply' : 'dry-run';
  const allowRemote = argv.includes('--allow-remote');
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
    const plans = [];
    for (const entry of MIGRATED_LAYOUTS) {
      const { rows: [layout] } = await client.query('SELECT id, name, "componentType" FROM "Layout" WHERE id = $1', [entry.id]);
      if (!layout) {
        console.log(`layout ${entry.id}: not found; nothing to do`);
        continue;
      }
      const { rows: scenes } = await client.query('SELECT id, metadata FROM "Scene" WHERE "layoutId" = $1 ORDER BY id', [entry.id]);
      const plan = planBracketMigration({ direction: mode === 'revert' ? 'revert' : 'apply', layout, scenes });
      for (const line of describePlan(plan, layout.name)) console.log(line);
      plans.push({ plan, layout, scenes });
    }
    for (const entry of UNCHANGED_LAYOUTS) {
      const { rows: [layout] } = await client.query('SELECT id, name, "componentType" FROM "Layout" WHERE id = $1', [entry.id]);
      if (layout) console.log(`layout ${layout.id} (${layout.name}): unchanged; componentType ${layout.componentType} renders Bleecker's podcast player`);
    }
    if (mode === 'dry-run') return;
    await client.query('BEGIN');
    try {
      for (const { plan } of plans) {
        if (plan.refused || plan.alreadyApplied) continue;
        const to = plan.layoutChange.componentTypeAfter;
        await client.query('UPDATE "Layout" SET "componentType" = $1, "updatedAt" = now() WHERE id = $2 AND "componentType" = $3', [to, plan.layoutId, plan.layoutChange.componentTypeBefore]);
        for (const change of plan.sceneChanges) {
          await client.query('UPDATE "Scene" SET metadata = $1, "updatedAt" = now() WHERE id = $2', [change.metadataAfter, change.sceneId]);
        }
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

module.exports = { planBracketMigration, renameKey, describePlan, hostAllowed, LEGACY, GIORGIA, MIGRATED_LAYOUTS };

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
