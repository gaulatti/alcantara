import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

// gaulatti/alcantara#191: every Bleecker overlay (the 15 modals, the playlist
// sheet, the command spotlight) and every Radix popper (Select, Tooltip) must
// paint above the mobile navigation at every width. jsdom
// does not lay out CSS, so this guards the numbers the browser check relies on:
// the one overlay rule in app.css against the chrome's z-indexes in layout.tsx.
const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

it("keeps Bleecker's overlay layer above the mobile navigation", () => {
  const css = read("./app.css");
  const rule = css.match(
    /\[data-bleecker-modal-overlay\],\s*\[data-radix-popper-content-wrapper\]\s*\{\s*z-index:\s*(\d+)\s*!important;\s*\}/,
  );
  expect(rule).not.toBeNull();
  const overlay = Number(rule![1]);

  const layout = read("./routes/layout.tsx");
  // One top bar at every width sits in the flow, so there is no fixed header to stack under.
  expect(layout).not.toMatch(/<header className='fixed inset-x-0 top-0/);
  const navigation = layout.match(/<div className='fixed inset-0 z-\[(\d+)\] xl:hidden' role='dialog'/);
  expect(navigation).not.toBeNull();

  expect(overlay).toBeGreaterThan(Number(navigation![1]));
});
