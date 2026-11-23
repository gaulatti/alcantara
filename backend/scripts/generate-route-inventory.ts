// gaulatti/alcantara#156: regenerates src/api-surface/route-inventory.json from
// the application's registered routes, sorted by path then method, by running
// the inventory spec in its write mode (one implementation for both).
//
//   npx ts-node scripts/generate-route-inventory.ts
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { join } from 'node:path';

export const BACKEND = join(__dirname, '..');

type Run = (
  command: string,
  args: string[],
  options: { cwd: string; stdio: 'inherit'; env: NodeJS.ProcessEnv },
) => Pick<SpawnSyncReturns<Buffer>, 'status'>;

/** Runs the inventory spec in write mode; answers the exit status to use. */
export function generateRouteInventory(
  run: Run = spawnSync,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const result = run(
    'npx',
    ['jest', 'src/api-surface/route-inventory.spec.ts'],
    {
      cwd: BACKEND,
      stdio: 'inherit',
      env: { ...env, ROUTE_INVENTORY_WRITE: '1' },
    },
  );
  return result.status ?? 1;
}

if (require.main === module) process.exit(generateRouteInventory());
