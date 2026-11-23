import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';

// gaulatti/alcantara#382: Tailwind does not scan node_modules, so the classes the packaged scenes use
// (the legacy bracket's utilities) exist in the app's stylesheet only when app.css names the package
// as a source. Without it the bracket loses its layout, which no unit test of the component can see.
it('lets Tailwind generate the classes of the packaged Modo Italiano scenes', () => {
  const css = readFileSync(join(__dirname, '..', 'app.css'), 'utf8');
  expect(css).toContain('@source "../node_modules/@modoitaliano/giorgia/dist/scenes/**/*.js";');
});
