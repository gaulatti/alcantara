import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// During a backend handover (gaulatti/alcantara#873) a request that reaches the instance that is stopping gets 503
// with Retry-After before it runs. The console sends it again quietly, so the caller sees the answer of the instance
// that took over, not an error.

const API = "https://api.alcantara.test";
const takeover = (retryAfter: string | null = "2") =>
  new Response(JSON.stringify({ statusCode: 503 }), {
    status: 503,
    headers: retryAfter === null ? {} : { "Retry-After": retryAfter },
  });
const ok = () => new Response("{}", { status: 200 });

async function install(path = "/calls") {
  const nativeFetch = vi.fn();
  const reportInvalidSession = vi.fn();
  vi.stubGlobal("fetch", nativeFetch);
  vi.doMock("../utils/apiBaseUrl", () => ({ getApiBaseUrl: () => API }));
  vi.doMock("./session", () => ({ getAppSession: vi.fn().mockResolvedValue({ token: "fictional-token" }) }));
  vi.doMock("./session-events", () => ({ reportInvalidSession }));
  window.history.replaceState({}, "", path);
  const module = await import("./authenticatedFetch");
  module.installAuthenticatedFetch();
  return { nativeFetch, reportInvalidSession, window: module.TAKEOVER_RETRY_WINDOW_MS };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  window.history.replaceState({}, "", "/");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("a backend handover's 503", () => {
  it("is sent again after Retry-After, and the caller gets the answer of the backend that took over", async () => {
    const h = await install();
    h.nativeFetch.mockResolvedValueOnce(takeover()).mockResolvedValueOnce(ok());
    const pending = fetch(`${API}/webrtc/participants?programId=main`);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(h.nativeFetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    const response = await pending;
    expect(response.status).toBe(200);
    expect(h.nativeFetch).toHaveBeenCalledTimes(2);
    expect(new Headers(h.nativeFetch.mock.calls[1][1].headers).get("Authorization")).toBe("Bearer fictional-token");
    expect(h.reportInvalidSession).not.toHaveBeenCalled();
  });

  it("keeps trying for the retry window, then hands the 503 to the caller", async () => {
    const h = await install();
    h.nativeFetch.mockImplementation(async () => takeover());
    const pending = fetch(`${API}/program/main`);
    await vi.advanceTimersByTimeAsync(h.window);
    const response = await pending;
    expect(response.status).toBe(503);
    // At 0, 2, 4 and 6 s: a couple of seconds of quiet retries, never longer than the window.
    expect(h.nativeFetch).toHaveBeenCalledTimes(4);
    expect(h.window).toBe(6_000);
  });

  it.each([
    ["no Retry-After", takeover(null)],
    ["an empty Retry-After", takeover(" ")],
    ["a Retry-After that is not a number of seconds", takeover("Fri, 27 Nov 2026 08:00:00 GMT")],
    ["a negative Retry-After", takeover("-1")],
    ["another status with Retry-After", new Response(null, { status: 429, headers: { "Retry-After": "2" } })],
  ])("returns at once with %s", async (_name, answer) => {
    const h = await install();
    h.nativeFetch.mockResolvedValue(answer);
    const response = await fetch(`${API}/program/main`);
    expect(response.status).toBe(answer.status);
    expect(h.nativeFetch).toHaveBeenCalledTimes(1);
  });

  it("waits at most 5 s however long Retry-After asks", async () => {
    const h = await install();
    h.nativeFetch.mockResolvedValueOnce(takeover("30")).mockResolvedValueOnce(ok());
    const pending = fetch(`${API}/program/main`);
    await vi.advanceTimersByTimeAsync(5_000);
    expect((await pending).status).toBe(200);
  });

  it("sends a Request's body again from a copy, and does not retry a streamed body", async () => {
    const h = await install();
    const bodies: string[] = [];
    h.nativeFetch.mockImplementation(async (input: Request) => {
      bodies.push(await input.text());
      return bodies.length === 1 ? takeover() : ok();
    });
    const pending = fetch(new Request(`${API}/webrtc/cue`, { method: "POST", body: '{"cue":"live"}' }));
    await vi.advanceTimersByTimeAsync(2_000);
    expect((await pending).status).toBe(200);
    expect(bodies).toEqual(['{"cue":"live"}', '{"cue":"live"}']);

    h.nativeFetch.mockReset();
    h.nativeFetch.mockResolvedValue(takeover());
    const stream = new ReadableStream({ start: (controller) => controller.close() });
    const response = await fetch(`${API}/media/upload`, { method: "POST", body: stream, duplex: "half" } as RequestInit);
    expect(response.status).toBe(503);
    expect(h.nativeFetch).toHaveBeenCalledTimes(1);
  });

  it("stops retrying once the caller aborts, before or during the wait", async () => {
    const h = await install();
    h.nativeFetch.mockResolvedValue(takeover());
    const during = new AbortController();
    const pending = fetch(`${API}/program/main`, { signal: during.signal });
    await vi.advanceTimersByTimeAsync(1_000);
    during.abort();
    await vi.advanceTimersByTimeAsync(1_000);
    expect((await pending).status).toBe(503);
    expect(h.nativeFetch).toHaveBeenCalledTimes(1);

    const before = new AbortController();
    h.nativeFetch.mockImplementationOnce(async () => {
      before.abort();
      return takeover();
    });
    expect((await fetch(`${API}/program/main`, { signal: before.signal })).status).toBe(503);
    expect(h.nativeFetch).toHaveBeenCalledTimes(2);
  });

  it("retries on the pages that call the backend without a session too, and never for other origins", async () => {
    const h = await install("/guest/fictional-invitation");
    h.nativeFetch.mockResolvedValueOnce(takeover()).mockResolvedValueOnce(ok());
    const pending = fetch(`${API}/webrtc/join`);
    await vi.advanceTimersByTimeAsync(2_000);
    expect((await pending).status).toBe(200);
    expect(h.nativeFetch.mock.calls[0][1]).toBeUndefined();

    h.nativeFetch.mockReset();
    h.nativeFetch.mockResolvedValue(takeover());
    expect((await fetch("https://elsewhere.example/api")).status).toBe(503);
    expect(h.nativeFetch).toHaveBeenCalledTimes(1);
  });
});
