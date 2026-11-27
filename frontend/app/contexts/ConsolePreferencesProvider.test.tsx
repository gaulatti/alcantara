import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ConsolePreferencesProvider,
  defaultConsoleProfile,
  detectDeviceClass,
  readPreferenceCache,
  useConsolePreferences,
} from "./ConsolePreferencesContext";

const mocks = vi.hoisted(() => ({ user: undefined as any, loaded: true }));
vi.mock("react-redux", () => ({
  useSelector: (selector: string) => (selector === "user" ? mocks.user : mocks.loaded),
}));
vi.mock("../state/selectors/auth", () => ({ currentUser: "user", isLoaded: "loaded" }));
vi.mock("../utils/apiBaseUrl", () => ({ getApiBaseUrl: () => "http://api.test" }));

let ctx: ReturnType<typeof useConsolePreferences>;
function Probe() {
  ctx = useConsolePreferences();
  return null;
}
const res = (status: number, body: unknown = {}) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as any;
const fetchMock = vi.fn();
const flush = (ms = 0) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));
const mountProvider = async () => {
  render(
    <ConsolePreferencesProvider>
      <Probe />
    </ConsolePreferencesProvider>,
  );
  await flush();
};
const serverProfile = { ...defaultConsoleProfile("desktop"), workspace: "audio" as const };
const cacheKey = "alcantara.console.acknowledged.u1.desktop";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  window.localStorage.clear();
  Object.defineProperty(window, "innerWidth", { value: 1400, configurable: true });
  mocks.user = { id: "u1", principalId: null };
  mocks.loaded = true;
  fetchMock.mockReset().mockResolvedValue(res(200, { version: 3, profile: serverProfile }));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("detectDeviceClass", () => {
  const scope = (userAgent: string, innerWidth: number, platform = "", maxTouchPoints = 0) =>
    ({ innerWidth, navigator: { userAgent, platform, maxTouchPoints } }) as any;
  it("classifies phones, tablets and desktops", () => {
    expect(detectDeviceClass(scope("iPhone", 1400))).toBe("phone");
    expect(detectDeviceClass(scope("Android Mobile", 1400))).toBe("phone");
    expect(detectDeviceClass(scope("x", 500))).toBe("phone");
    expect(detectDeviceClass(scope("iPad", 1400))).toBe("tablet");
    expect(detectDeviceClass(scope("x", 1400, "MacIntel", 5))).toBe("tablet");
    expect(detectDeviceClass(scope("x", 1400, "MacIntel", 0))).toBe("desktop");
    expect(detectDeviceClass(scope("x", 1000))).toBe("tablet");
    expect(detectDeviceClass(scope("x", 1400))).toBe("desktop");
  });
  it("reads the window when no scope is given and is desktop without one", () => {
    expect(detectDeviceClass()).toBe("desktop");
    vi.stubGlobal("window", undefined);
    expect(detectDeviceClass()).toBe("desktop");
  });
});

describe("defaults and cache reads", () => {
  it("builds a profile per device class", () => {
    expect(defaultConsoleProfile("phone")).toMatchObject({ workspace: "compact", touchMode: true, shortcutsEnabled: false });
    expect(defaultConsoleProfile("phone")).not.toHaveProperty("dockWidth");
    expect(defaultConsoleProfile("tablet").dockWidth).toBe(300);
    expect(defaultConsoleProfile("desktop").dockWidth).toBe(320);
  });
  it("returns null without an identity, a legacy cache, or a valid entry", () => {
    expect(readPreferenceCache(undefined, "desktop")).toBeNull();
    expect(readPreferenceCache({ id: "", principalId: "p" }, "desktop")).toBeNull();
    expect(readPreferenceCache({ id: "u", principalId: "p" }, "desktop")).toBeNull();
    window.localStorage.setItem("alcantara.console.acknowledged.u.desktop", "{not json");
    expect(readPreferenceCache({ id: "u" }, "desktop")).toBeNull();
    for (const bad of ['{"version":1.5,"profile":{}}', '{"version":1}', '{"version":1,"profile":3}', "null"]) {
      window.localStorage.setItem("alcantara.console.acknowledged.u.desktop", bad);
      expect(readPreferenceCache({ id: "u" }, "desktop")).toBeNull();
    }
  });
});

describe("ConsolePreferencesProvider", () => {
  it("refuses to be read outside the provider", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => render(<Probe />)).toThrow("ConsolePreferencesProvider is missing");
    spy.mockRestore();
  });

  it("does nothing until the session is loaded and a user is known", async () => {
    mocks.loaded = false;
    await mountProvider();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(ctx.syncState).toBe("loading");
    cleanup();
    mocks.loaded = true;
    mocks.user = undefined;
    await mountProvider();
    expect(fetchMock).not.toHaveBeenCalled();
    await act(async () => {
      ctx.adoptAcknowledged(9, serverProfile);
      await ctx.resetAll();
    });
    expect(ctx.version).toBe(0);
  });

  it("loads the server profile and caches it", async () => {
    await mountProvider();
    expect(fetchMock).toHaveBeenCalledWith("http://api.test/operator-preferences/desktop");
    expect(ctx).toMatchObject({ syncState: "synced", version: 3, deviceClass: "desktop", detectedDeviceClass: "desktop" });
    expect(ctx.profile.workspace).toBe("audio");
    expect(JSON.parse(window.localStorage.getItem(cacheKey)!).version).toBe(3);
  });

  it("starts from the acknowledged cache while the server answers", async () => {
    window.localStorage.setItem(cacheKey, JSON.stringify({ version: 2, profile: { ...serverProfile, workspace: "graphics" } }));
    fetchMock.mockReturnValue(new Promise(() => {}));
    await mountProvider();
    expect(ctx).toMatchObject({ version: 2, syncState: "loading" });
    expect(ctx.profile.workspace).toBe("graphics");
  });

  it("degrades when the server refuses, then recovers by polling", async () => {
    fetchMock.mockResolvedValueOnce(res(500));
    await mountProvider();
    expect(ctx.syncState).toBe("degraded");
    fetchMock.mockResolvedValueOnce(res(500));
    await flush(5000);
    expect(ctx.syncState).toBe("degraded");
    await flush(5000);
    expect(ctx.syncState).toBe("synced");
    expect(ctx.version).toBe(3);
  });

  it("honours a stored device class override and ignores an invalid one", async () => {
    window.localStorage.setItem("alcantara.console.deviceClassOverride", "phone");
    await mountProvider();
    expect(ctx.deviceClass).toBe("phone");
    cleanup();
    window.localStorage.setItem("alcantara.console.deviceClassOverride", "watch");
    await mountProvider();
    expect(ctx.deviceClass).toBe("desktop");
  });

  it("sets and clears the device class override and reloads for the new class", async () => {
    await mountProvider();
    await act(async () => ctx.setDeviceClassOverride("tablet"));
    await flush();
    expect(window.localStorage.getItem("alcantara.console.deviceClassOverride")).toBe("tablet");
    expect(ctx.deviceClass).toBe("tablet");
    expect(fetchMock).toHaveBeenLastCalledWith("http://api.test/operator-preferences/tablet");
    await act(async () => ctx.setDeviceClassOverride(null));
    await flush();
    expect(window.localStorage.getItem("alcantara.console.deviceClassOverride")).toBeNull();
    expect(ctx.deviceClass).toBe("desktop");
  });

  it("saves an edit after the debounce and adopts the saved version", async () => {
    await mountProvider();
    fetchMock.mockResolvedValue(res(200, { version: 4, profile: { ...serverProfile, touchMode: true } }));
    await act(async () => ctx.updateProfile({ touchMode: true }));
    await flush(699);
    expect(fetchMock.mock.calls.some((c) => c[1]?.method === "PUT")).toBe(false);
    await flush(1);
    const put = fetchMock.mock.calls.find((c) => c[1]?.method === "PUT")!;
    expect(put[0]).toBe("http://api.test/operator-preferences/desktop");
    expect(JSON.parse(put[1].body)).toMatchObject({ version: 3, profile: { touchMode: true } });
    expect(ctx).toMatchObject({ version: 4, syncState: "synced" });
  });

  // gaulatti/alcantara#875: on a tablet, picking a show while the stored profile was still loading was undone when it
  // arrived (and saved back), so the radio desk came up on another show in one run and the right one in the next.
  it("keeps an edit made while the server profile loads, on top of it, and saves it at the server's version", async () => {
    let answer!: (value: unknown) => void;
    fetchMock.mockReset();
    fetchMock.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
    fetchMock.mockResolvedValue(res(200, { version: 4, profile: { ...serverProfile, selectedProgramId: "radio-demo.fm" } }));
    await mountProvider();
    act(() => ctx.updateProfile({ selectedProgramId: "radio-demo.fm" }));
    answer(res(200, { version: 3, profile: { ...serverProfile, selectedProgramId: "main" } }));
    await flush();
    expect(ctx.profile.selectedProgramId).toBe("radio-demo.fm");
    // The rest of the server's profile is adopted.
    expect(ctx.profile.workspace).toBe("audio");
    await flush(700);
    const put = fetchMock.mock.calls.find(([, init]) => init?.method === "PUT");
    expect(JSON.parse(put![1].body)).toMatchObject({ version: 3, profile: { selectedProgramId: "radio-demo.fm", workspace: "audio" } });
    expect(ctx.profile.selectedProgramId).toBe("radio-demo.fm");
  });

  it("keeps nothing extra when two loads overlap and the earlier one answers last", async () => {
    const answers: Array<(value: unknown) => void> = [];
    fetchMock.mockReset();
    fetchMock.mockImplementation(() => new Promise((resolve) => answers.push(resolve)));
    await mountProvider();
    act(() => ctx.setDeviceClassOverride("tablet"));
    await flush();
    expect(answers).toHaveLength(2);
    answers[1](res(200, { version: 7, profile: { ...defaultConsoleProfile("tablet"), selectedProgramId: "radio-demo.fm" } }));
    await flush();
    answers[0](res(200, { version: 3, profile: serverProfile }));
    await flush(700);
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "PUT")).toBe(false);
  });

  it("adopts the server profile as it is when nothing was edited while it loaded", async () => {
    await mountProvider();
    expect(ctx.profile).toEqual(serverProfile);
    await flush(700);
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "PUT")).toBe(false);
  });

  it("keeps the edit dirty and retries every five seconds when the save fails", async () => {
    await mountProvider();
    fetchMock.mockResolvedValueOnce(res(500));
    await act(async () => ctx.updateProfile({ touchMode: true }));
    await flush(700);
    expect(ctx.syncState).toBe("degraded");
    fetchMock.mockResolvedValue(res(200, { version: 5, profile: serverProfile }));
    await flush(5000);
    expect(ctx).toMatchObject({ syncState: "synced", version: 5 });
    fetchMock.mockReset().mockRejectedValueOnce(new Error("net"));
    await act(async () => ctx.updateProfile({ touchMode: false }));
    await flush(700);
    expect(ctx.syncState).toBe("degraded");
  });

  describe("conflicts", () => {
    const conflicted = async () => {
      await mountProvider();
      fetchMock.mockResolvedValue(res(409, { authoritative: { version: 8, profile: { ...serverProfile, workspace: "compact" } } }));
      await act(async () => ctx.updateProfile({ touchMode: true }));
      await flush(700);
    };
    it("records the conflict and takes the server's profile", async () => {
      await conflicted();
      expect(ctx.syncState).toBe("conflict");
      expect(ctx.conflict?.version).toBe(8);
      await act(async () => ctx.useAuthoritative());
      expect(ctx).toMatchObject({ conflict: null, syncState: "synced", version: 8 });
      expect(ctx.profile.workspace).toBe("compact");
    });
    it("retries the local profile on top of the authoritative version", async () => {
      await conflicted();
      fetchMock.mockResolvedValue(res(200, { version: 9, profile: serverProfile }));
      await act(async () => ctx.retryLocal());
      expect(ctx.version).toBe(8);
      expect(ctx.profile.touchMode).toBe(true);
      await flush(5000);
      expect(ctx).toMatchObject({ syncState: "synced", version: 9, conflict: null });
    });
    it("does not save or poll while a conflict is open", async () => {
      await conflicted();
      const before = fetchMock.mock.calls.length;
      await flush(20_000);
      expect(fetchMock.mock.calls.length).toBe(before);
    });
    it("ignores authoritative/retry requests when there is no conflict", async () => {
      await mountProvider();
      await act(async () => {
        ctx.useAuthoritative();
        ctx.retryLocal();
      });
      expect(ctx).toMatchObject({ syncState: "synced", version: 3 });
    });
  });

  it("adopts an acknowledged profile from a loaded preset", async () => {
    await mountProvider();
    await act(async () => ctx.adoptAcknowledged(12, { ...serverProfile, workspace: "graphics" }));
    expect(ctx).toMatchObject({ version: 12, syncState: "synced", conflict: null });
    expect(JSON.parse(window.localStorage.getItem(cacheKey)!).version).toBe(12);
  });

  describe("reset", () => {
    it("clears this class's caches and returns to defaults", async () => {
      mocks.user = { id: "u1", principalId: "p1" };
      await mountProvider();
      window.localStorage.setItem("alcantara.console.acknowledged.u1.desktop", "x");
      fetchMock.mockResolvedValue(res(200));
      await act(async () => ctx.resetCurrent());
      expect(fetchMock).toHaveBeenLastCalledWith("http://api.test/operator-preferences/desktop", { method: "DELETE" });
      expect(window.localStorage.getItem("alcantara.console.acknowledged.u1.desktop")).toBeNull();
      expect(ctx).toMatchObject({ version: 0, syncState: "synced" });
      expect(ctx.profile).toEqual(defaultConsoleProfile("desktop"));
    });
    it("clears every class on reset all", async () => {
      await mountProvider();
      for (const c of ["desktop", "tablet", "phone"]) window.localStorage.setItem(`alcantara.console.acknowledged.u1.${c}`, "x");
      fetchMock.mockResolvedValue(res(200));
      await act(async () => ctx.resetAll());
      expect(fetchMock).toHaveBeenLastCalledWith("http://api.test/operator-preferences", { method: "DELETE" });
      expect(window.localStorage.getItem("alcantara.console.acknowledged.u1.tablet")).toBeNull();
      expect(window.localStorage.getItem("alcantara.console.acknowledged.u1.phone")).toBeNull();
    });
    it("rejects with the status when the server refuses", async () => {
      await mountProvider();
      fetchMock.mockResolvedValue(res(403));
      await expect(act(async () => ctx.resetAll())).rejects.toThrow("Reset failed (403)");
    });
  });
});
