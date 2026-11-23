import { AxiosError } from "axios";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getAppSession: vi.fn(), reportInvalidSession: vi.fn() }));
vi.mock("./session", () => ({ getAppSession: mocks.getAppSession }));
vi.mock("./session-events", () => ({ reportInvalidSession: mocks.reportInvalidSession }));

import { api, authFetch, handleApiError } from "./api";

const adapterCalls: any[] = [];
const respondWith = (...statuses: number[]) => {
  let i = 0;
  api.defaults.adapter = async (config: any) => {
    adapterCalls.push({ url: config.url, auth: config.headers.get?.("Authorization") ?? config.headers.Authorization });
    const status = statuses[Math.min(i++, statuses.length - 1)];
    const response = { status, statusText: "", data: { n: i }, headers: {}, config };
    if (status >= 400) throw new AxiosError("fail", "ERR", config, null, response as any);
    return response;
  };
};

beforeEach(() => {
  adapterCalls.length = 0;
  mocks.getAppSession.mockReset().mockResolvedValue({ token: "t1" });
  mocks.reportInvalidSession.mockReset();
});

describe("api client", () => {
  it("sends the bearer token when there is one", async () => {
    respondWith(200);
    await api.get("/x");
    expect(adapterCalls[0].auth).toBe("Bearer t1");
  });
  it("sends no token for a session without one or when the session lookup fails", async () => {
    respondWith(200);
    mocks.getAppSession.mockResolvedValue({});
    await api.get("/x");
    mocks.getAppSession.mockRejectedValue(new Error("none"));
    await api.get("/y");
    expect(adapterCalls.map((c) => c.auth)).toEqual([undefined, undefined]);
  });
  it("passes the request error through", async () => {
    const handler = (api.interceptors.request as any).handlers[0].rejected;
    await expect(handler(new Error("boom"))).rejects.toThrow("boom");
  });
  it("refreshes the session once after a 401 and retries with the new token", async () => {
    respondWith(401, 200);
    let current = "t1";
    mocks.getAppSession.mockImplementation(async (force?: boolean) => {
      if (force) current = "t2";
      return { token: current };
    });
    const response = await api.get("/x");
    expect(response.status).toBe(200);
    expect(adapterCalls.map((c) => c.auth)).toEqual(["Bearer t1", "Bearer t2"]);
    expect(mocks.reportInvalidSession).not.toHaveBeenCalled();
  });
  it("reports an invalid session when the refresh yields no token or fails", async () => {
    respondWith(401);
    mocks.getAppSession.mockImplementation(async (force?: boolean) => (force ? {} : { token: "t1" }));
    await expect(api.get("/x")).rejects.toThrow("Refreshed session has no ID token");
    expect(mocks.reportInvalidSession).toHaveBeenCalledTimes(1);
    mocks.reportInvalidSession.mockClear();
    mocks.getAppSession.mockImplementation(async (force?: boolean) => {
      if (force) throw new Error("refresh failed");
      return { token: "t1" };
    });
    await expect(api.get("/x")).rejects.toThrow("refresh failed");
    expect(mocks.reportInvalidSession).toHaveBeenCalledTimes(1);
  });
  it("reports an invalid session when the retry itself is refused with 401", async () => {
    respondWith(401, 401);
    mocks.getAppSession.mockResolvedValue({ token: "t" });
    await expect(api.get("/x")).rejects.toBeInstanceOf(AxiosError);
    expect(mocks.reportInvalidSession).toHaveBeenCalled();
  });
  it("rejects other errors without reporting, and reports a 401 that has no request config", async () => {
    respondWith(500);
    await expect(api.get("/x")).rejects.toBeInstanceOf(AxiosError);
    expect(mocks.reportInvalidSession).not.toHaveBeenCalled();
    const handler = (api.interceptors.response as any).handlers[0].rejected;
    await expect(handler({ response: { status: 401 } })).rejects.toBeDefined();
    expect(mocks.reportInvalidSession).toHaveBeenCalledTimes(1);
    await expect(handler({})).rejects.toBeDefined();
    expect(mocks.reportInvalidSession).toHaveBeenCalledTimes(1);
  });
});

describe("authFetch", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
  });
  it("adds the bearer token and keeps the caller's headers and options", async () => {
    await authFetch("/things", { method: "POST", headers: { "X-A": "1" } });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(/\/things$/);
    expect(init.method).toBe("POST");
    expect(init.headers.get("Authorization")).toBe("Bearer t1");
    expect(init.headers.get("X-A")).toBe("1");
  });
  it("sends the request unauthenticated when there is no token or no session", async () => {
    mocks.getAppSession.mockResolvedValue({});
    await authFetch("/a");
    mocks.getAppSession.mockRejectedValue(new Error("x"));
    await authFetch("/b");
    expect(fetchMock.mock.calls.map((c) => c[1].headers.get("Authorization"))).toEqual([null, null]);
  });
});

describe("handleApiError", () => {
  const axiosError = (status?: number, data?: any, message = "m") =>
    new AxiosError(message, "E", undefined, null, status ? ({ status, data } as any) : undefined);
  it("explains API errors, common statuses and unknown failures", () => {
    expect(handleApiError(axiosError(400, { error: "Bad name" }))).toBe("Bad name");
    expect(handleApiError(axiosError(404))).toBe("Resource not found");
    expect(handleApiError(axiosError(403))).toBe("Access denied");
    expect(handleApiError(axiosError(500))).toBe("Server error. Please try again later.");
    expect(handleApiError(axiosError(418, {}, "teapot"))).toBe("teapot");
    expect(handleApiError(axiosError(undefined, undefined, "offline"))).toBe("offline");
    expect(handleApiError(new Error("x"))).toBe("An unexpected error occurred");
  });
});
