import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { expect, it } from "vitest";

// gaulatti/alcantara#723: opening a Bleecker (Radix) tooltip in jsdom leaves a stall of about 5 s
// before the next test in the same file starts, and a later test can then exceed Vitest's timeout.
// The reproduction is a bare Bleecker Tooltip, so the cause is upstream; see the Bleecker ticket linked
// from #723. Until it is fixed, a test file that opens a tooltip must keep that test alone in its file.
// This check is the lint-style guard: a test file that queries a tooltip must hold exactly one test.

// Vitest runs from the frontend directory, where the app source lives under ./app.
const APP = join(process.cwd(), "app");
const TOOLTIP_QUERY = /role=["']?tooltip|\[role=tooltip\]|role\s*:\s*["']tooltip["']|getByRole\(\s*["']tooltip["']/;
const SELF = join(APP, "tooltip-isolation.test.ts");
const TEST_CALL = /^\s*(?:it|test)(?:\.\w+)?\(/gm;

function testFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return testFiles(path);
    return /\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

it("keeps each test file that opens a tooltip to that one test", () => {
  const offenders = testFiles(APP)
    .map((path) => ({ path, source: readFileSync(path, "utf8") }))
    .filter(({ path, source }) => path !== SELF && TOOLTIP_QUERY.test(source))
    .map(({ path, source }) => ({
      file: relative(APP, path),
      tests: (source.match(TEST_CALL) ?? []).length,
    }))
    .filter(({ tests }) => tests !== 1);
  expect(offenders).toEqual([]);
});

it("finds the tooltip file this guard exists for, so the check is not vacuous", () => {
  const tooltipFiles = testFiles(APP).filter((path) => path !== SELF && TOOLTIP_QUERY.test(readFileSync(path, "utf8")));
  expect(tooltipFiles.map((path) => relative(APP, path))).toContain("components/PlaybackBar.tooltip.test.tsx");
});
