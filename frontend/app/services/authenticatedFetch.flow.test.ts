import { afterEach, describe, expect, it, vi } from "vitest";

const res = (status: number) => new Response("{}", { status });

async function setup(opts: { base?: string; session?: any; native?: any } = {}) {
  vi.resetModules();
  const native = opts.native ?? vi.fn().mockResolvedValue(res(200));
  const getAppSession = opts.session ?? vi.fn().mockResolvedValue({ token: "t1" });
  const reportInvalidSession = vi.fn();
  vi.stubGlobal("fetch", native);
  vi.doMock("../utils/apiBaseUrl", () => ({ getApiBaseUrl: () => opts.base ?? "https://api.test" }));
  vi.doMock("./session", () => ({ getAppSession }));
  vi.doMock("./session-events", () => ({ reportInvalidSession }));
  const mod = await import("./authenticatedFetch");
  mod.installAuthenticatedFetch();
  return { mod, native, getAppSession, reportInvalidSession, patched: globalThis.fetch };
}
const auth = (call: any[]) => new Headers(call[1].headers).get("Authorization");

afterEach(() => {
  window.history.replaceState({}, "", "/");
  vi.unstubAllGlobals();
  vi.doUnmock("../utils/apiBaseUrl");
  vi.doUnmock("./session");
  vi.doUnmock("./session-events");
});

describe("public renderer paths", () => {
  it("matches a single program segment only", async () => {
    const { mod } = await setup();
    expect(mod.isPublicProgramRendererPath("/program/x")).toBe(true);
    expect(mod.isPublicProgramRendererPath("/program/x/")).toBe(true);
    expect(mod.isPublicProgramRendererPath("/program/x/control")).toBe(false);
    expect(mod.isPublicProgramRendererPath("/control")).toBe(false);
  });
});

describe("installation", () => {
  it("installs once", async () => {
    const { mod, patched } = await setup();
    mod.installAuthenticatedFetch();
    expect(globalThis.fetch).toBe(patched);
  });
  it("does nothing without a window", async () => {
    vi.resetModules();
    const native = vi.fn();
    vi.stubGlobal("fetch", native);
    const mod = await import("./authenticatedFetch");
    vi.stubGlobal("window", undefined);
    try {
      mod.installAuthenticatedFetch();
    } finally {
      vi.stubGlobal("window", globalThis);
    }
    expect(globalThis.fetch).toBe(native);
  });
});

describe("which requests are authenticated", () => {
  it("authenticates strings, URLs and Requests to the backend, and leaves other origins alone", async () => {
    const { native, patched } = await setup();
    await patched("https://api.test/x");
    await patched(new URL("https://api.test/y"));
    await patched(new Request("https://api.test/z", { headers: { "X-R": "1" } }));
    expect(native.mock.calls.map(auth)).toEqual(["Bearer t1", "Bearer t1", "Bearer t1"]);
    expect(new Headers(native.mock.calls[2][1].headers).get("X-R")).toBe("1");
    expect(native.mock.calls[2][0]).toBeInstanceOf(Request);
    native.mockClear();
    await patched("https://elsewhere.test/a", { method: "POST" });
    expect(native).toHaveBeenCalledWith("https://elsewhere.test/a", { method: "POST" });
  });
  it("respects a base path", async () => {
    const { native, patched } = await setup({ base: "https://api.test/v1/" });
    await patched("https://api.test/v1");
    await patched("https://api.test/v1/things");
    expect(native.mock.calls.map(auth)).toEqual(["Bearer t1", "Bearer t1"]);
    native.mockClear();
    await patched("https://api.test/v10/things");
    await patched("https://api.test/other");
    expect(native.mock.calls.map((c: unknown[]) => c[1])).toEqual([undefined, undefined]);
  });
  it("sends the caller's own headers over the Request's", async () => {
    const { native, patched } = await setup();
    await patched("https://api.test/a", { headers: { "X-C": "2" } });
    expect(new Headers(native.mock.calls[0][1].headers).get("X-C")).toBe("2");
  });
  it("leaves backend calls public on the renderer page", async () => {
    window.history.replaceState({}, "", "/program/live");
    const { native, getAppSession, patched } = await setup();
    await patched("https://api.test/program/live/state");
    expect(getAppSession).not.toHaveBeenCalled();
    expect(native).toHaveBeenCalledWith("https://api.test/program/live/state", undefined);
  });
});

describe("session problems", () => {
  it("reports an unavailable session and sends the original request unauthenticated", async () => {
    const { native, reportInvalidSession, patched } = await setup({ session: vi.fn().mockRejectedValue(new Error("x")) });
    await patched("https://api.test/a", { method: "PUT" });
    expect(reportInvalidSession).toHaveBeenCalledTimes(1);
    expect(native).toHaveBeenCalledWith("https://api.test/a", { method: "PUT" });
  });
  it("fails when the session has no token", async () => {
    const { patched, native } = await setup({ session: vi.fn().mockResolvedValue({}) });
    await expect(patched("https://api.test/a")).rejects.toThrow("Authenticated session has no ID token");
    expect(native).not.toHaveBeenCalled();
  });
  it("lets a network error through", async () => {
    const { patched } = await setup({ native: vi.fn().mockRejectedValue(new Error("offline")) });
    await expect(patched("https://api.test/a")).rejects.toThrow("offline");
  });
});

describe("401 handling", () => {
  it("refreshes the session and returns the retried response", async () => {
    const native = vi.fn().mockResolvedValueOnce(res(401)).mockResolvedValueOnce(res(200));
    const session = vi.fn(async (force?: boolean) => ({ token: force ? "t2" : "t1" }));
    const { patched, reportInvalidSession } = await setup({ native, session });
    expect((await patched("https://api.test/a")).status).toBe(200);
    expect(session).toHaveBeenNthCalledWith(2, true);
    expect(auth(native.mock.calls[1])).toBe("Bearer t2");
    expect(reportInvalidSession).not.toHaveBeenCalled();
  });
  it("reports an invalid session when the retry is still refused", async () => {
    const native = vi.fn().mockResolvedValue(res(401));
    const { patched, reportInvalidSession } = await setup({ native });
    expect((await patched("https://api.test/a")).status).toBe(401);
    expect(reportInvalidSession).toHaveBeenCalledTimes(1);
  });
  it("returns the first 401 and reports when the refresh cannot get a session", async () => {
    const native = vi.fn().mockResolvedValue(res(401));
    const session = vi.fn(async (force?: boolean) => {
      if (force) throw new Error("refresh");
      return { token: "t1" };
    });
    const { patched, reportInvalidSession } = await setup({ native, session });
    expect((await patched("https://api.test/a")).status).toBe(401);
    expect(reportInvalidSession).toHaveBeenCalledTimes(1);
    expect(native).toHaveBeenCalledTimes(1);
  });
  it("returns the first 401 without reporting when the retry fails for another reason", async () => {
    const native = vi.fn().mockResolvedValueOnce(res(401)).mockRejectedValueOnce(new Error("offline"));
    const { patched, reportInvalidSession } = await setup({ native });
    expect((await patched("https://api.test/a")).status).toBe(401);
    expect(reportInvalidSession).not.toHaveBeenCalled();
  });
});
