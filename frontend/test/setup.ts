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
