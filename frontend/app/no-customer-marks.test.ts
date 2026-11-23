// gaulatti/alcantara#333: the console is Alcántara's product, used by several
// customers. No customer's station name, hashtag or domain may be hardcoded in
// the app's code; each program supplies its own marks from its configuration.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const appDir = __dirname;
// Retired or customer-only marks that once shipped as defaults.
const MARKS = /modoradio|modosanremo|#modoitalianomr|bienvenidos a modoradio/i;

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(tsx?|css)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

describe("customer marks", () => {
  it("are not hardcoded anywhere in the app", () => {
    const offenders = sources(appDir).filter((path) => MARKS.test(readFileSync(path, "utf8")));
    expect(offenders.map((path) => relative(appDir, path))).toEqual([]);
  });
});
