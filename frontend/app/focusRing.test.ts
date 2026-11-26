import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';

// Ticket #688 (decision 3): one focus-visible ring for every link, button and field, from the shared
// style. Mouse styling is unchanged, because :focus-visible does not match a mouse press. The test
// reads the stylesheets, since jsdom does not apply CSS to computed focus styles.
const read = (name: string) => readFileSync(join(__dirname, name), 'utf8');

it('gives every link and button one focus-visible ring from app.css', () => {
  const css = read('app.css');
  expect(css).toMatch(/:where\(a\[href\], button, summary, input, select, \[role="button"\], \[role="tab"\]\):focus-visible \{\s*outline: 2px solid var\(--focus-ring, var\(--app-sea\)\);/);
});

it('keeps the console colour by setting the ring token, and has no scoped copies of the rule', () => {
  expect(read('components/BroadcastConsole.css')).toContain('--focus-ring: var(--console-ready);');
  expect(read('components/BroadcastConsole.css')).not.toMatch(/:is\(button, input, select, a, summary\):focus-visible/);
  expect(read('components/BroadcastConsole.css')).not.toMatch(/:is\(button, input\):focus-visible/);
});
