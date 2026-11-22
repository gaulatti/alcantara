import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const amplify = vi.hoisted(() => ({ fetchAuthSession: vi.fn(), signOut: vi.fn() }));
vi.mock("aws-amplify/auth", () => amplify);

const KEY = "alcantara.testAuth.session";
const rawFetch = vi.fn();
const payload = (over: any = {}) => ({
  accessToken: "tok-1",
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  user: { sub: "sub-1", name: "N", email: "e@x.test" },
  ...over,
});
const load = async () => {
  vi.resetModules();
  return import("./session");
};

beforeEach(() => {
  rawFetch.mockReset().mockResolvedValue({ ok: true, status: 200, json: async () => payload() });
  vi.stubGlobal("fetch", rawFetch);
  amplify.fetchAuthSession.mockReset();
  amplify.signOut.mockReset();
  window.sessionStorage.clear();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("provider session", () => {
  it("is not test auth by default and maps the provider session", async () => {
    const mod = await load();
    expect(mod.isTestAuth()).toBe(false);
    amplify.fetchAuthSession.mockResolvedValue({ userSub: "u", tokens: { idToken: { toString: () => "id-token", payload: { a: 1 } } } });
    expect(await mod.getAppSession(true)).toEqual({ userSub: "u", token: "id-token", payload: { a: 1 } });
    expect(amplify.fetchAuthSession).toHaveBeenCalledWith({ forceRefresh: true });
  });
  it("maps a session without tokens", async () => {
    const mod = await load();
    amplify.fetchAuthSession.mockResolvedValue({});
    expect(await mod.getAppSession()).toEqual({ userSub: undefined, token: undefined, payload: undefined });
  });
  it("signs out of the provider", async () => {
    const mod = await load();
    await mod.clearAppSession();
    expect(amplify.signOut).toHaveBeenCalled();
  });
});

describe("test auth", () => {
  beforeEach(() => vi.stubEnv("VITE_AUTH_MODE", "test"));

  it("fetches a local session once, for the default identity, and stores it", async () => {
    const mod = await load();
    expect(mod.isTestAuth()).toBe(true);
    const [a, b] = await Promise.all([mod.getAppSession(), mod.getAppSession()]);
    expect(a).toBe(b);
    expect(a).toMatchObject({ userSub: "sub-1", token: "tok-1" });
    expect(rawFetch).toHaveBeenCalledTimes(1);
    expect(String(rawFetch.mock.calls[0][0])).toContain("/__test/session?identity=operator-a");
    expect(JSON.parse(window.sessionStorage.getItem(KEY)!).token).toBe("tok-1");
  });
  it("uses the configured identity", async () => {
    vi.stubEnv("VITE_TEST_AUTH_IDENTITY", "operator b");
    const mod = await load();
    await mod.getAppSession();
    expect(String(rawFetch.mock.calls[0][0])).toContain("identity=operator%20b");
  });
  it("reuses a stored session that is still valid without asking the server", async () => {
    window.sessionStorage.setItem(KEY, JSON.stringify({ ...payload(), token: "stored", userSub: "s" , expiresAt: new Date(Date.now() + 3_600_000).toISOString() }));
    const mod = await load();
    expect((await mod.getAppSession()).token).toBe("stored");
    expect(rawFetch).not.toHaveBeenCalled();
  });
  it("ignores stored sessions that are expired, incomplete or unreadable", async () => {
    const stale = [
      { token: "t", userSub: "s", expiresAt: new Date(Date.now() + 10_000).toISOString() },
      { token: "t", userSub: "s" },
      { token: "t", expiresAt: new Date(Date.now() + 3_600_000).toISOString() },
      { userSub: "s", expiresAt: new Date(Date.now() + 3_600_000).toISOString() },
    ];
    for (const s of stale) {
      window.sessionStorage.setItem(KEY, JSON.stringify(s));
      rawFetch.mockClear();
      const mod = await load();
      expect((await mod.getAppSession()).token).toBe("tok-1");
      expect(rawFetch).toHaveBeenCalledTimes(1);
    }
    window.sessionStorage.setItem(KEY, "{broken");
    rawFetch.mockClear();
    const mod = await load();
    await mod.getAppSession();
    expect(rawFetch).toHaveBeenCalledTimes(1);
    window.sessionStorage.setItem(KEY, "null");
    const again = await load();
    await again.getAppSession();
  });
  it("forgets the session on a forced refresh and fetches a new one", async () => {
    const mod = await load();
    await mod.getAppSession();
    rawFetch.mockResolvedValue({ ok: true, status: 200, json: async () => payload({ accessToken: "tok-2" }) });
    expect((await mod.getAppSession(true)).token).toBe("tok-2");
    expect(rawFetch).toHaveBeenCalledTimes(2);
  });
  it("fails when the local session endpoint refuses", async () => {
    rawFetch.mockResolvedValue({ ok: false, status: 404 });
    const mod = await load();
    await expect(mod.getAppSession()).rejects.toThrow("Test session failed (404)");
  });
  it("clears the local session without touching the provider", async () => {
    const mod = await load();
    await mod.getAppSession();
    await mod.clearAppSession();
    expect(window.sessionStorage.getItem(KEY)).toBeNull();
    expect(amplify.signOut).not.toHaveBeenCalled();
    await mod.getAppSession();
    expect(rawFetch).toHaveBeenCalledTimes(2);
  });
});
