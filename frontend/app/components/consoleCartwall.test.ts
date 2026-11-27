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
  const rule = lastRule('.radio-tools .radio-cartwall');
  expect(rule).toMatch(/flex:\s*1 0 auto/);
  expect(rule).toMatch(/max-height:\s*320px/);
});

it('puts two pads across in a tablet column, so a sounder name can be read', () => {
  expect(css).toMatch(
    /@media \(min-width: 1024px\) and \(max-width: 1279px\) \{\s*\.radio-cartwall \.console-cart-grid \{\s*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/,
  );
});
