import { describe, expect, it, vi } from "vitest";
import { deployedBuild, runningBuild } from "./buildVersion";

// Which console build runs here and which is deployed (gaulatti/alcantara#879): never guessed when unreadable.

describe("buildVersion", () => {
  it("reads the running build from the loaded manifest, and nothing otherwise", () => {
    expect(runningBuild({ __reactRouterManifest: { version: "b8cadd70" } })).toBe("b8cadd70");
    expect(runningBuild({ __reactRouterManifest: { version: "" } })).toBeNull();
    expect(runningBuild({ __reactRouterManifest: { version: 7 } })).toBeNull();
    expect(runningBuild({})).toBeNull();
    expect(runningBuild()).toBeNull();
  });

  it("reads the deployed build from a fresh index page", async () => {
    const fetchImpl = vi.fn(async () => new Response('<link rel="modulepreload" href="/assets/manifest-c0ffee12.js"/>'));
    await expect(deployedBuild(fetchImpl as never, "https://console.example.test")).resolves.toBe("c0ffee12");
    expect(fetchImpl).toHaveBeenCalledWith("https://console.example.test/", { cache: "no-store", credentials: "same-origin" });
  });

  it("says nothing when the page cannot be read or names no build", async () => {
    await expect(deployedBuild((async () => new Response("", { status: 503 })) as never, "x")).resolves.toBeNull();
    await expect(deployedBuild((async () => new Response("<html></html>")) as never, "x")).resolves.toBeNull();
    await expect(deployedBuild((async () => Promise.reject(new Error("offline"))) as never, "x")).resolves.toBeNull();
  });
});
