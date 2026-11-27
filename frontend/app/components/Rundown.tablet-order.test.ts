import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// At tablet width the rundown keeps three columns: the library, the block's events and the editor (the v2 layout).
// The events are never pushed below the library. A stylesheet rule, read as text.
describe("rundown on tablet", () => {
  const css = readFileSync(join(__dirname, "Rundown.css"), "utf8");
  const tablet = css.slice(css.indexOf("@media (max-width: 1100px) {\n  .rundown-desk"));

  it("keeps the library, the events and the editor side by side at 1024", () => {
    expect(tablet).toMatch(/\.rundown-desk \{\s*grid-template-columns: 200px minmax\(0, 1fr\) 250px;/);
    expect(css).toMatch(/\.rundown-desk \{\s*display: grid;\s*\/\*[^*]*\*\/\s*grid-template-columns: 220px minmax\(0, 1fr\) 300px;/);
  });
});
