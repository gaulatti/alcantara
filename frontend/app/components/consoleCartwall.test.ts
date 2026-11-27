import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';

// alcantara#875: on a tablet at 1024 x 768 the cartwall, the one panel of the tools column allowed to shrink, was
// squeezed until its pads were cut in half. jsdom lays nothing out, so the rules are checked at their source.
const css = readFileSync(join(__dirname, 'BroadcastConsole.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const lastRule = (selector: string) => {
  const found = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter((match) => match[1].trim() === selector);
  return found.at(-1)?.[2] ?? '';
};

it('keeps the cartwall at its own height beside the desk, up to a bound where it scrolls itself', () => {
  expect(css).toMatch(/\.radio-tools \.radio-cartwall \{\s*flex: 1 0 auto;[^}]*max-height: 320px;/);
});

// The output confidence panel left the column (its reading is the strip's status dot), so the 1440 cap is 300 px and the
// guests, now a row of the mixer grid, still fit above the fold.
it('caps the cartwall shorter at 1440 px only, so the guest list fits above the fold', () => {
  expect(css).toMatch(
    /@media \(min-width: 1440px\) and \(max-width: 1535px\) \{\s*\.radio-tools \.radio-cartwall \{\s*max-height: 300px;/,
  );
});

it('puts two pads across in a tablet column, so a sounder name can be read', () => {
  expect(css).toMatch(
    /@media \(min-width: 1024px\) and \(max-width: 1279px\) \{\s*\.radio-cartwall \.console-cart-grid \{\s*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/,
  );
});

it('gives a finger full-size targets on the desk: mixer buttons, pre-listen and the rotation row actions', () => {
  expect(css).toMatch(/@media \(pointer: coarse\) \{\s*\.broadcast-console \.console-channel button \{\s*min-height: 44px;/);
  expect(css).toMatch(/button\[aria-label\^="Pre-listen"\] \{\s*min-width: 44px;\s*min-height: 44px;/);
  const editor = readFileSync(join(__dirname, 'editors/ProgramSongSequenceEditor.tsx'), 'utf8');
  const small = [...editor.matchAll(/className=\{?[`']flex h-6 w-6[^`']*[`']/g)].map((match) => match[0]);
  expect(small.length).toBeGreaterThan(5);
  expect(small.filter((classes) => !classes.includes('pointer-coarse:h-11'))).toEqual([]);
});
