import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';

// gaulatti/alcantara#382: the Modo Italiano renderers are @modoitaliano/giorgia's. A renderer added
// under app/components/ would be a second copy of one, so the files named after the brand there are
// an explicit allowlist: the program row and the artist bumper are app code that places library
// scenes, not renderers of their own.
const ALLOWED = new Set([
  'ModoItalianoProgramRow.tsx',
  'ModoItalianoProgramRow.test.tsx',
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
