import '@testing-library/jest-dom/vitest';
import { configure } from '@testing-library/react';
import { afterEach } from 'vitest';
import { resetPlatformForTests } from '../app/utils/cartModifier';

// findBy and waitFor give up after 1 s by default. A passing test returns as soon as its condition holds,
// so a longer limit costs nothing when it passes and only keeps a loaded CI runner from failing it.
configure({ asyncUtilTimeout: 10_000 });

// The cart modifier is read once per page; tests start on a Mac (Ctrl+letter) and
// stub another platform explicitly. See setPlatformForTests in cartModifier tests.
export function setPlatformForTests(platform: string): void {
  Object.defineProperty(window.navigator, 'platform', { configurable: true, get: () => platform });
  resetPlatformForTests();
}
setPlatformForTests('MacIntel');
afterEach(() => {
  setPlatformForTests('MacIntel');
});

// Node 25 and later define their own global `localStorage`, which is undefined
// unless Node runs with --localstorage-file. Vitest's jsdom environment does not
// overwrite a global that already exists, so on those Node versions
// `window.localStorage` would be Node's empty value instead of jsdom's Storage.
// Use the jsdom window's own storage so the suite behaves the same on every
// supported Node. On Node 22, where no such global exists, this changes nothing.
const jsdomWindow = (globalThis as { jsdom?: { window: Window } }).jsdom?.window;
for (const name of ['localStorage', 'sessionStorage'] as const) {
  if (jsdomWindow && globalThis[name] !== jsdomWindow[name]) {
    Object.defineProperty(globalThis, name, {
      configurable: true,
      value: jsdomWindow[name],
    });
  }
}

// jsdom has no matchMedia. The audio list reads the phone breakpoint, so tests get the desktop
// layout unless they stub the query themselves (gaulatti/alcantara#668).
if (!window.matchMedia) {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

// gaulatti/alcantara#723: floating-ui (Radix tooltips and popovers) asks `element.matches(':modal')` and
// `':popover-open'` on every position update to detect the top layer. jsdom's selector engine (nwsapi) resolves
// `:modal` through `:fullscreen`, which calls `matches` again and recurses until the stack overflows; floating-ui
// catches the error, so each check silently cost seconds and a file that opened one tooltip took about 12 s.
// jsdom has no top layer, dialog modality or fullscreen, so these selectors match nothing: answer that directly.
const TOP_LAYER_SELECTOR = /^\s*:(modal|popover-open|fullscreen)\s*$/;
const nativeMatches = Element.prototype.matches;
Element.prototype.matches = function matches(this: Element, selectors: string) {
  if (TOP_LAYER_SELECTOR.test(selectors)) return false;
  return nativeMatches.call(this, selectors);
};
