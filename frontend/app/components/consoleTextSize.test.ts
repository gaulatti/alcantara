import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// gaulatti/alcantara#347 and #392: no text under 12 px in the live console (the switcher deck and the
// TV audio workspace). The rendered sizes come from three places, and each is checked at its source:
// the console stylesheet, Tailwind size classes, and Bleecker's StatePill, which sets 11 px unless a
// text-xs class overrides it. The test-mode badge is the one exclusion and lives outside these files.
const read = (name: string) => readFileSync(join(__dirname, name), 'utf8');

describe('console text size', () => {
  it('declares no font size under 12px in BroadcastConsole.css', () => {
    const small = [...read('BroadcastConsole.css').matchAll(/font-size:\s*(\d+(?:\.\d+)?)px/g)]
      .map((match) => Number(match[1]))
      .filter((size) => size < 12);
    expect(small).toEqual([]);
  });

  for (const file of ['BroadcastSwitcherDeck.tsx', 'TvAudioWorkspace.tsx']) {
    it(`uses no Tailwind text size under 12px in ${file}`, () => {
      const source = read(file);
      const small = [...source.matchAll(/text-\[(\d+(?:\.\d+)?)px\]/g)].map((match) => Number(match[1])).filter((size) => size < 12);
      expect(small).toEqual([]);
      expect(source).not.toMatch(/\btext-(?:\[0?\.\d+rem\]|2xs)\b/);
    });
  }

  it('gives every StatePill in the switcher deck a 12px size', () => {
    const source = read('BroadcastSwitcherDeck.tsx');
    const pills = [...source.matchAll(/<StatePill\b[\s\S]*?\/>/g)].map((match) => match[0]);
    expect(pills.length).toBeGreaterThan(0);
    expect(pills.filter((pill) => !/className=("|\{`)[^"`]*\btext-xs\b/.test(pill))).toEqual([]);
  });
});
