import { describe, expect, it, vi } from "vitest";

vi.mock("@react-router/dev/routes", () => ({
  route: (path: string, file: string) => ({ path, file }),
  index: (file: string) => ({ index: true, file }),
  layout: (file: string, children: unknown[]) => ({ layout: file, children }),
}));

import routes from "./routes";

const flatten = (nodes: any[]): any[] => nodes.flatMap((n) => (n.children ? [n, ...flatten(n.children)] : [n]));

describe("route table", () => {
  const all = flatten(routes as any[]);
  it("keeps sign-in public and everything else behind the protected layout, except the on-air pages", () => {
    const top = (routes as any[]).map((n) => n.path ?? n.layout);
    expect(top).toEqual(["login", "logout", "routes/protected.tsx", "guest/:invitation", "return-router/:programId", "program/:id"]);
  });
  it("serves the control desk at the index and every console page inside the app layout", () => {
    const appLayout = flatten((routes as any[]).filter((n) => n.layout === "routes/protected.tsx")).find((n) => n.layout === "routes/layout.tsx");
    const children = appLayout.children;
    expect(children.find((n: any) => n.index).file).toBe("routes/control.tsx");
    const paths = children.filter((n: any) => n.path).map((n: any) => n.path);
    for (const path of ["control", "instants", "songs", "media", "scenes", "programs", "radio-settings", "access", "flight"]) expect(paths).toContain(path);
    expect(paths).toContain("radio-output/:programId");
  });
  it("points every route at an existing module path with a unique URL", () => {
    const paths = all.filter((n) => n.path).map((n) => n.path);
    expect(new Set(paths).size).toBe(paths.length);
    for (const n of all.filter((n) => n.file)) expect(n.file).toMatch(/^routes\/[\w.-]+\.tsx$/);
  });
});
