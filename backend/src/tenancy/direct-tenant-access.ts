import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { TENANCY_CLASSIFICATION } from './tenancy-classification';

/**
 * Direct access to a tenant model (gaulatti/alcantara#122, slice 1): `prisma.<tenantModel>` outside the tenancy module,
 * which reads and writes every team's rows instead of going through the scoped client (`forTeam`, scoped-prisma.ts).
 *
 * The tenant models are the ones the classification calls `tenant`, so a new tenant model is covered with no second
 * list. A use is a member access on a receiver named `prisma` (`this.prisma.song.findMany`, `prisma.song.count`); a
 * scoped client is named otherwise (`songDb`, `scoped`). A transaction client (`tx.song`) is not counted. Spec and
 * testing files, comment lines, and the tenancy module itself are not read.
 */
export const TENANT_DELEGATES: readonly string[] = Object.entries(TENANCY_CLASSIFICATION)
  .filter(([, tenancy]) => tenancy.kind === 'tenant')
  .map(([model]) => model.charAt(0).toLowerCase() + model.slice(1));

/** A file's direct uses by delegate, as `{ "song": 3 }`. */
export type DirectUses = Record<string, number>;

/** The direct uses in one file's text. */
export function directTenantUses(text: string, delegates: readonly string[] = TENANT_DELEGATES): DirectUses {
  const pattern = new RegExp(`\\bprisma\\s*\\.\\s*(${delegates.join('|')})\\s*\\.`, 'g');
  const uses: DirectUses = {};
  for (const line of text.split('\n')) {
    const code = line.trim();
    if (code.startsWith('//') || code.startsWith('*') || code.startsWith('/*')) continue;
    for (const match of line.matchAll(pattern)) uses[match[1]] = (uses[match[1]] ?? 0) + 1;
  }
  return uses;
}

/** The files the check reads under `root` (backend/src), by path relative to the backend. */
function sourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'tenancy') files.push(...sourceFiles(path));
    } else if (/\.ts$/.test(entry.name) && !/\.(spec|testing|d)\.ts$/.test(entry.name)) {
      files.push(path);
    }
  }
  return files;
}

/** Every direct use under backend/src, by file (relative to the backend) and delegate. */
export function scanDirectTenantUses(backendRoot: string): Record<string, DirectUses> {
  const found: Record<string, DirectUses> = {};
  for (const file of sourceFiles(join(backendRoot, 'src')).sort()) {
    const uses = directTenantUses(readFileSync(file, 'utf8'));
    if (Object.keys(uses).length) found[relative(backendRoot, file)] = uses;
  }
  return found;
}

/** What differs from the baseline: new or increased uses, and uses the baseline still lists that are gone. */
export function directAccessProblems(
  found: Record<string, DirectUses>,
  baseline: Record<string, DirectUses>,
): { added: string[]; stale: string[] } {
  const added: string[] = [];
  const stale: string[] = [];
  for (const [file, uses] of Object.entries(found))
    for (const [delegate, count] of Object.entries(uses)) {
      const allowed = baseline[file]?.[delegate] ?? 0;
      if (count > allowed) added.push(`${file}: prisma.${delegate} ${count} (baseline ${allowed})`);
    }
  for (const [file, uses] of Object.entries(baseline))
    for (const [delegate, allowed] of Object.entries(uses)) {
      const count = found[file]?.[delegate] ?? 0;
      if (count < allowed) stale.push(`${file}: prisma.${delegate} ${count} (baseline ${allowed})`);
    }
  return { added, stale };
}
