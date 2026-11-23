import { afterEach, expect, it, vi } from "vitest";
import { activateScene, completeSceneCountdown } from "./program";
vi.mock("../utils/apiBaseUrl", () => ({
  apiUrl: (path: string) => `http://api.test${path}`,
}));
afterEach(() => vi.unstubAllGlobals());
it("returns the authoritative Program state after TAKE", async () => {
  const state = { activeSceneId: 80, stagedSceneId: 20, stateVersion: 4 };
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
it("asks the API to take the scene the countdown on air points to, without naming one", async () => {
  const state = { activeSceneId: 75, stagedSceneId: 11, stateVersion: 5 };
  const request = vi.fn(async () => new Response(JSON.stringify(state)));
  vi.stubGlobal("fetch", request);
  expect(await completeSceneCountdown("show/test")).toEqual(state);
  expect(request).toHaveBeenCalledWith(
    "http://api.test/program/show%2Ftest/countdown/complete",
    { method: "POST" },
  );
});
it("rejects a refused countdown with the backend error", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(JSON.stringify({ message: "No countdown on air" }), {
          status: 400,
        }),
    ),
  );
  await expect(completeSceneCountdown("main")).rejects.toThrow(
    "No countdown on air",
  );
});
it("reports the HTTP failure of a countdown when the response is not JSON", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("Unavailable", { status: 503 })),
  );
  await expect(completeSceneCountdown("main")).rejects.toThrow("HTTP 503");
});
