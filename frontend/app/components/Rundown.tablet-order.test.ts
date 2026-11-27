import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// At tablet width the rundown stacks the library and the timeline. The block's own events must come first, so the
// add-audio catalog cannot push them off the screen (gaulatti/alcantara#875). A stylesheet rule, read as text.
describe("rundown on tablet", () => {
  const css = readFileSync(join(__dirname, "Rundown.css"), "utf8");
  const tablet = css.slice(css.indexOf("@media (max-width: 1100px) {\n  .rundown-builder"));

  it("puts the timeline before the library when stacked", () => {
    expect(tablet).toMatch(/\.rundown-builder > \.rundown-timeline \{\s*order: 0;/);
    expect(tablet).toMatch(/\.rundown-builder > \.rundown-library \{\s*order: 1;/);
  });
});
