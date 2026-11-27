import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';

// alcantara#875, tablet: jsdom lays nothing out, so the touch rules and the markup they reach are checked at source.
const read = (name: string) => readFileSync(join(__dirname, name), 'utf8');
const deck = read('BroadcastSwitcherDeck.tsx');
const css = read('BroadcastConsole.css');

it('gives Listen, Workspace options and the sort headers finger-sized targets', () => {
  const touch = css.slice(css.indexOf('on a tablet Listen'));
  expect(touch).toMatch(/@media \(pointer: coarse\)/);
  expect(touch).toMatch(/\.switcher-return-listen \{\s*min-width: 44px;\s*min-height: 32px;/);
  expect(touch).toMatch(/\.switcher-options-summary \{\s*min-height: 44px;/);
  expect(touch).toMatch(/thead th button \{\s*min-height: 44px;/);
  expect(deck).toContain('switcher-options-summary');
  expect(read('../routes/media.tsx')).toContain('pointer-coarse:min-h-11 pointer-coarse:min-w-11');
});

// The longest source name was cut to "Local preview hea…" exactly when it carried the Preview pill.
it('wraps a long source name instead of cutting it', () => {
  expect(deck).toMatch(/className="switcher-source-name line-clamp-2 [^"]*break-words/);
});
