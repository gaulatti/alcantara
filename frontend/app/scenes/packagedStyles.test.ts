import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';

// gaulatti/alcantara#382: Tailwind does not scan node_modules, so a utility class a packaged scene uses exists in
// the app's stylesheet only when app.css names the package as a source. The current scenes style themselves inline;
// the source line keeps any class a later version adds from silently losing its layout.
it('lets Tailwind generate the classes of the packaged Modo Italiano scenes', () => {
  const css = readFileSync(join(__dirname, '..', 'app.css'), 'utf8');
  expect(css).toContain('@source "../node_modules/@modoitaliano/giorgia/dist/scenes/**/*.js";');
});
