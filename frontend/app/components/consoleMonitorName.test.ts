import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';

// alcantara#875: at 1024 px the program monitor's header gave the scene name no width. jsdom lays nothing out, so the
// rule and the markup it hides are checked at their source.
const read = (name: string) => readFileSync(join(__dirname, name), 'utf8');

it('keeps room for the scene name below 1280 px by hiding what is said elsewhere', () => {
  expect(read('BroadcastConsole.css')).toMatch(
    /@media \(max-width: 1279px\) \{\s*\.switcher-monitor header \.switcher-return-local,\s*\.switcher-monitor header \.switcher-return-listen-label \{\s*display: none;/,
  );
  const deck = read('BroadcastSwitcherDeck.tsx');
  expect(deck).toContain('<span className="switcher-return-listen-label">Listen</span>');
  // The button keeps its name when only the icon shows.
  expect(deck).toMatch(/className="switcher-return-listen"\s*aria-label="Listen"/);
});
