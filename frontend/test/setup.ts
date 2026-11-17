import '@testing-library/jest-dom/vitest';

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
