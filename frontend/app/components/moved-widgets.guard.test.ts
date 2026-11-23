import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// gaulatti/alcantara#383: a widget that moved to @gaulatti/bleecker keeps only a thin module here, which
// re-exports the library's component or passes the console's data into it. A renderer that grows back in
// the app would fork the library's copy, so this fails the build when one does.
const MOVED = [
  'ChyronHolder',
  'ClockWidget',
  'CronicaBackground',
  'CronicaChyron',
  'CronicaReiteramos',
  'LiveIndicator',
  'LogoWidget',
  'QRCodeWidget',
  'RelojClone',
  'RelojDigitalLoopClock',
  'RelojLoopClock',
  'Slideshow',
  'StreamWall',
  'Ticker',
  'ToniChyron',
  'ToniClock',
  'ToniLogo',
  'VideoStream',
  'WebrtcGuestSource',
];

describe('moved widgets stay thin wrappers over the library', () => {
  for (const name of MOVED) {
    it(`${name} wraps the library component`, () => {
      const source = readFileSync(resolve('app/components', `${name}.tsx`), 'utf8');
      expect(source).toMatch(/@gaulatti\/bleecker\/components\/|@fifthbell\/brokaw\/components\/|from '\.\.\/bleecker'/);
      expect(source.split('\n').length).toBeLessThan(100);
      expect(source).not.toMatch(/\.css'/);
    });
  }
});
