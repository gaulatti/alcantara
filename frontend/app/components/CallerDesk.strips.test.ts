import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The guest slots on /calls (gaulatti/alcantara#875): a tall guest card must not stretch the free slots beside it, and
// the room's return line spans the whole grid rather than taking a column of its own. Read as text, since the layout
// is the browser's.
describe("guest slots layout on /calls", () => {
  const css = readFileSync(join(__dirname, "CallerDesk.css"), "utf8");
  const strips = css.slice(css.indexOf(".caller-desk-strips {"), css.indexOf("}", css.indexOf(".caller-desk-strips {")) + 1);

  it("keeps each slot at its own height", () => {
    expect(strips).toMatch(/align-items:\s*start/);
  });

  it("lets the return line span the whole grid", () => {
    const calls = readFileSync(join(__dirname, "..", "routes", "calls.tsx"), "utf8");
    expect(calls).toMatch(/className='col-span-full text-sm font-medium' data-return-sending/);
  });
});
