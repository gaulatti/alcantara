import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';

// gaulatti/alcantara#382: the Modo Italiano renderers are @modoitaliano/giorgia's. A renderer added
// under app/components/ would be a second copy of one, so the files named after the brand there are
// an explicit allowlist: the program row and the artist bumper are app code that places library
// scenes, not renderers of their own.
const ALLOWED = new Set([
  'ModoItalianoProgramRow.tsx',
  'ModoItalianoProgramRow.test.tsx',
  'ModoItalianoProgramRow.library.test.tsx',
  'ModoItalianoGiorgiaArtistBumper.tsx',
  'ModoItalianoGiorgiaArtistBumper.test.tsx',
  'ModoItalianoGiorgiaArtistBumperPlayer.tsx',
  'ModoItalianoGiorgiaArtistBumperPlayer.test.tsx',
]);

it('keeps renderer components named for Modo Italiano or Giorgia out of app/components/', () => {
  const dir = join(__dirname, '..', 'components');
  const offenders = readdirSync(dir).filter((name) => /^(ModoItaliano|Giorgia)/.test(name) && !ALLOWED.has(name));
  expect(offenders).toEqual([]);
});

// gaulatti/alcantara#383: every scene renderer is a library's. components/index.ts is the registry of
// what the program page can place; each module it re-exports must be a thin host over a library part:
// it imports from Bleecker, Brokaw or Giorgia, has no stylesheet of its own, and stays small. A
// renderer written here again (markup and CSS copied back) fails one of the three.
const MAX_ADAPTER_LINES = 130;
const LIBRARIES = ["'../bleecker'", "'@gaulatti/bleecker", "'@modoitaliano/giorgia", "'@fifthbell/brokaw", "'../scenes/packagedScenes'"];
// The bumper loads its player (the Giorgia video entry) lazily; the player is the one that imports it.
const VIA_PLAYER = "import('./ModoItalianoGiorgiaArtistBumperPlayer')";
// The artist bumper resolves its images from a media label (app data) before handing four URLs to Giorgia's video.
const LARGER_ADAPTERS: Record<string, number> = { ModoItalianoGiorgiaArtistBumper: 160 };

it('keeps every scene renderer a thin host over a library part', () => {
  const dir = join(__dirname, '..', 'components');
  const barrel = readFileSync(join(dir, 'index.ts'), 'utf8');
  const modules = [...new Set([...barrel.matchAll(/from '(\.\/[A-Za-z]+)'/g)].map((match) => match[1].slice(2)))];
  expect(modules.length).toBeGreaterThan(10);
  const problems: string[] = [];
  for (const name of modules) {
    const path = join(dir, `${name}.${existsSync(join(dir, `${name}.tsx`)) ? 'tsx' : 'ts'}`);
    const source = readFileSync(path, 'utf8');
    const lines = source.split('\n').length;
    if (/import\s+['"]\.\/[A-Za-z.]+\.css['"]/.test(source)) problems.push(`${name}: imports its own stylesheet`);
    if (!LIBRARIES.some((library) => source.includes(`from ${library}`)) && !source.includes(VIA_PLAYER)) problems.push(`${name}: imports no library`);
    const limit = LARGER_ADAPTERS[name] ?? MAX_ADAPTER_LINES;
    if (lines > limit) problems.push(`${name}: ${lines} lines (more than ${limit})`);
  }
  expect(problems).toEqual([]);
});
