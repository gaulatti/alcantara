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

  // Bleecker 0.1.54 sizes StatePill and StatusBadge at 12px by default (gaulatti/bleecker#588), so
  // the console passes no override; the guard is that it never asks for the 11px size or re-forces 12px.
  it('leaves StatePill and StatusBadge at their 12px default in the switcher deck and the header', () => {
    for (const file of ['BroadcastSwitcherDeck.tsx', 'SimulcastStatusRail.tsx']) {
      const source = read(file);
      const badges = [...source.matchAll(/<(?:StatePill|StatusBadge)\b[\s\S]*?\/>/g)].map((match) => match[0]);
      expect(badges.length).toBeGreaterThan(0);
      // Only the pills and badges: the deck's buttons take their own sizes.
      expect(badges.filter((badge) => /size=["'{]+sm/.test(badge))).toEqual([]);
      const overrides = badges.filter((badge) => /text-xs|\[&>span:first-child\]/.test(badge));
      expect(overrides).toEqual([]);
    }
  });

  it('pins a Bleecker that sizes them: 0.1.54 or later', () => {
    const pin = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8')).dependencies['@gaulatti/bleecker'] as string;
    const [major, minor, patch] = pin.replace(/^[^\d]*/, '').split('.').map(Number);
    expect(major === 0 && minor === 1 ? patch >= 54 : major > 0 || minor > 1).toBe(true);
  });
});
