import { afterEach, expect, it, vi } from "vitest";
import { activateScene } from "./program";
vi.mock("../utils/apiBaseUrl", () => ({
  apiUrl: (path: string) => `http://api.test${path}`,
}));
afterEach(() => vi.unstubAllGlobals());
it("returns the authoritative Program state after TAKE", async () => {
  const state = { activeSceneId: 80, stateVersion: 4 };
  const request = vi.fn(async () => new Response(JSON.stringify(state)));
  vi.stubGlobal("fetch", request);
  expect(await activateScene("show/test", 80, "cut")).toEqual(state);
  expect(request).toHaveBeenCalledWith(
    "http://api.test/program/show%2Ftest/activate",
    expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ sceneId: 80, transitionId: "cut" }),
    }),
  );
});
it("rejects a failed TAKE with the backend error instead of reporting success", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(JSON.stringify({ message: "Scene is not assigned" }), {
          status: 400,
        }),
    ),
  );
  await expect(activateScene("main", 80)).rejects.toThrow(
    "Scene is not assigned",
  );
});
it("reports the HTTP failure when the response is not JSON", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("Unavailable", { status: 503 })),
  );
  await expect(activateScene("main", 80)).rejects.toThrow("HTTP 503");
});
