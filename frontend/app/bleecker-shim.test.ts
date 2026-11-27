import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { expect, it } from 'vitest';
import * as shim from './bleecker';

// The production build resolves `@gaulatti/bleecker` to app/bleecker.ts (vite.config.ts), while tests and the
// typecheck use the package itself. A component imported from the package but not re-exported by the shim passes
// both and breaks only the build (the podcast player did, on 11f06d8). Every value imported from the package must
// come out of the shim.
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

it('re-exports every value the app imports from @gaulatti/bleecker', () => {
  const app = __dirname;
  const missing: string[] = [];
  for (const file of sources(app)) {
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(/import\s+(?!type\b)\{([^}]*)\}\s+from\s+['"]@gaulatti\/bleecker['"]/g)) {
      for (const raw of match[1].split(',')) {
        const specifier = raw.trim();
        if (!specifier || specifier.startsWith('type ')) continue;
        const name = specifier.split(/\s+as\s+/)[0].trim();
        if (!(name in shim)) missing.push(`${relative(app, file)}: ${name}`);
      }
    }
  }
  expect(missing).toEqual([]);
});
