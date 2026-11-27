import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BroadcastSwitcherDeck, ConfidenceMonitor } from "./BroadcastSwitcherDeck";

const mocks = vi.hoisted(() => ({
  prefs: {} as any,
  features: { context: {} as any },
}));
vi.mock("../contexts/ConsolePreferencesContext", () => ({
  useConsolePreferences: () => mocks.prefs,
}));
vi.mock("../hooks/useFeatures", () => ({ useFeatures: () => mocks.features }));
vi.mock("../utils/apiBaseUrl", () => ({ getApiBaseUrl: () => "http://api.test" }));

const scene = { id: 1, name: "One" } as any;
const other = { id: 2, name: "Two" } as any;
const baseProps = () => ({
  programId: "prog 1",
  activeScene: scene,
  stagedScene: other,
  scenes: [scene, other],
  transitionId: "cut",
  realtimeConnected: false,
  fadeToBlack: false,
  workspace: "director" as const,
  onWorkspaceChange: vi.fn(),
  onTransitionChange: vi.fn(),
  onStageScene: vi.fn(),
  onTake: vi.fn(),
  onCut: vi.fn(),
  onFadeToBlack: vi.fn(),
});
const fetchMock = vi.fn();
const json = (status: number, body: unknown = {}) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as any;

beforeEach(() => {
  mocks.prefs = {
    profile: { touchMode: true, shortcutsEnabled: true },
    updateProfile: vi.fn(),
    syncState: "conflict",
    deviceClass: "tablet",
    detectedDeviceClass: "desktop",
    version: 4,
    conflict: true,
    setDeviceClassOverride: vi.fn(),
    useAuthoritative: vi.fn(),
    retryLocal: vi.fn(),
    resetCurrent: vi.fn(),
    resetAll: vi.fn(),
    adoptAcknowledged: vi.fn(),
  };
  mocks.features = { context: { authorization: { teamId: 9 } } };
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("ConfidenceMonitor", () => {
  it("shows a clear program/preview state when no scene is selected", () => {
    const { rerender } = render(<ConfidenceMonitor label="PREVIEW" tone="preview" scene={null} src="/x" />);
    expect(screen.getByText("Preview is clear")).toBeInTheDocument();
    expect(screen.getByText("No scene selected")).toBeInTheDocument();
    rerender(<ConfidenceMonitor label="PROGRAM" tone="program" scene={null} src="/x" />);
    expect(screen.getByText("Program is clear")).toBeInTheDocument();
  });
  it("scales the frame to its bounds and stays hidden until measured", () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ width: 960, height: 1080 } as DOMRect);
    render(<ConfidenceMonitor label="PROGRAM" tone="program" scene={scene} src="/s" />);
    const frame = screen.getByTitle("PROGRAM confidence monitor");
    expect(frame.style.transform).toContain("scale(0.5)");
    expect(frame.style.visibility).toBe("visible");
    vi.restoreAllMocks();
  });
  it("keeps the frame hidden at zero size", () => {
    render(<ConfidenceMonitor label="PROGRAM" tone="program" scene={scene} src="/s" />);
    expect(screen.getByTitle("PROGRAM confidence monitor").style.visibility).toBe("hidden");
  });
});

describe("workspace toolbar", () => {
  it("switches workspace, toggles touch/shortcuts/fullscreen and resizes the dock", () => {
    const props = baseProps();
    document.documentElement.requestFullscreen = vi.fn() as any;
    render(<BroadcastSwitcherDeck {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Audio" }));
    expect(mocks.prefs.updateProfile).toHaveBeenCalledWith({ workspace: "audio" });
    expect(props.onWorkspaceChange).toHaveBeenCalledWith("audio");
    fireEvent.click(screen.getByRole("button", { name: "Toggle keyboard shortcuts" }));
    expect(mocks.prefs.updateProfile).toHaveBeenCalledWith({ shortcutsEnabled: false });
    fireEvent.click(screen.getByRole("button", { name: "Toggle touch mode" }));
    expect(mocks.prefs.updateProfile).toHaveBeenCalledWith({ touchMode: false });
    fireEvent.click(screen.getByRole("button", { name: "Enter fullscreen" }));
    expect(document.documentElement.requestFullscreen).toHaveBeenCalled();
    // gaulatti/alcantara#392: the source panel width is Bleecker's Fader, not a native range input.
    expect(document.querySelector('input[type="range"]')).toBeNull();
    const width = screen.getByRole("slider", { name: /Source panel width/ });
    fireEvent.keyDown(width, { key: "ArrowRight" });
    expect(mocks.prefs.updateProfile).toHaveBeenCalledWith({ dockWidth: 310 });
    fireEvent.keyDown(width, { key: "End" });
    expect(mocks.prefs.updateProfile).toHaveBeenCalledWith({ dockWidth: 520 });
    expect(screen.getByTitle("Live updates disconnected")).toBeInTheDocument();
  });
  it("tolerates a browser without fullscreen and uses the default dock width", () => {
    document.documentElement.requestFullscreen = undefined as any;
    render(<BroadcastSwitcherDeck {...baseProps()} />);
    fireEvent.click(screen.getByRole("button", { name: "Enter fullscreen" }));
    expect(screen.getByRole("slider", { name: /Source panel width/ })).toHaveAttribute("aria-valuenow", "300");
  });
  it("labels the sources as preview, program, both or staged and the ready line", () => {
    render(<BroadcastSwitcherDeck {...baseProps()} scenes={[scene, other, { id: 3, name: "Three" } as any]} />);
    expect(screen.queryByText("Ready: Two")).toBeNull();
    expect(screen.getAllByText("Program")[0]).toBeInTheDocument();
    expect(screen.getAllByText("Preview")[0]).toBeInTheDocument();
    expect(screen.queryByText("Stage")).toBeNull();
    cleanup();
    render(<BroadcastSwitcherDeck {...baseProps()} activeScene={other} />);
    expect(screen.getByText("Preview · Program")).toBeInTheDocument();
  });
  it("shows the taking message while busy", () => {
    render(<BroadcastSwitcherDeck {...baseProps()} takeBusy />);
    expect(screen.getByText("Saving Preview and taking it to Program…")).toBeInTheDocument();
  });
  it("shows the stage error when the stage callback throws a non-error", async () => {
    const props = baseProps();
    props.onStageScene = vi.fn(async () => {
      throw "boom";
    });
    render(<BroadcastSwitcherDeck {...props} />);
    fireEvent.click(screen.getByRole("button", { name: /One/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not prepare Preview.");
  });
  it("clears the stage error when the program changes", async () => {
    const props = baseProps();
    props.onStageScene = vi.fn(async () => false);
    const { rerender } = render(<BroadcastSwitcherDeck {...props} />);
    fireEvent.click(screen.getByRole("button", { name: /One/ }));
    await screen.findByRole("alert");
    rerender(<BroadcastSwitcherDeck {...props} programId="other" />);
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });
});

describe("keyboard shortcuts", () => {
  const raf = () => vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => { cb(0); return 1; });
  it("ignores shortcuts typed into a field and never takes while busy", async () => {
    raf();
    const props = baseProps();
    const { rerender } = render(<BroadcastSwitcherDeck {...props} takeBusy />);
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Search scenes" }), { code: "Space", key: " " });
    fireEvent.keyDown(window, { code: "Space", key: " " });
    fireEvent.keyDown(window, { key: "c" });
    await new Promise((r) => setTimeout(r, 20));
    expect(props.onTake).not.toHaveBeenCalled();
    expect(props.onCut).not.toHaveBeenCalled();
    rerender(<BroadcastSwitcherDeck {...props} takeBusy={false} />);
    fireEvent.keyDown(document.body, { code: "Space", key: " " });
    await waitFor(() => expect(props.onTake).toHaveBeenCalledTimes(1));
  });
  it("registers nothing when shortcuts are disabled", async () => {
    mocks.prefs.profile = { touchMode: false, shortcutsEnabled: false };
    const props = baseProps();
    render(<BroadcastSwitcherDeck {...props} />);
    fireEvent.keyDown(window, { code: "Space", key: " " });
    await new Promise((r) => setTimeout(r, 20));
    expect(props.onTake).not.toHaveBeenCalled();
  });
  it("does not treat a window target as a blocked element", () => {
    render(<BroadcastSwitcherDeck {...baseProps()} />);
    fireEvent.keyDown(window, { key: "q" });
  });
  it("runs CUT and TAKE from the transport buttons", async () => {
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => { cb(0); return 1; });
    const props = baseProps();
    render(<BroadcastSwitcherDeck {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "CUT" }));
    await waitFor(() => expect(props.onCut).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "TAKE TO PROGRAM" }));
    await waitFor(() => expect(props.onTake).toHaveBeenCalled());
  });
});

describe("console presets", () => {
  const open = () => fireEvent.click(screen.getByRole("button", { name: "tablet preferences" }));
  const layout = { id: "L1", name: "Night", description: null, sourceDeviceClass: "desktop", version: 2 };

  it("hides the conflict box and the team scope without a team", async () => {
    mocks.prefs.conflict = false;
    mocks.features = { context: undefined };
    fetchMock.mockResolvedValue(json(200, []));
    render(<BroadcastSwitcherDeck {...baseProps()} />);
    open();
    expect(screen.queryByText("A newer profile exists.")).toBeNull();
    expect(screen.queryByRole("option", { name: "My team" })).toBeNull();
    await screen.findByText("No published presets.");
  });

  it("explains a load conflict and a generic load failure", async () => {
    let status = 409;
    fetchMock.mockImplementation(async (_u: string, init?: any) => (init?.method === "POST" ? json(status) : json(200, [layout])));
    render(<BroadcastSwitcherDeck {...baseProps()} />);
    open();
    await screen.findByText(/Night/);
    fireEvent.click(screen.getByRole("button", { name: "Load" }));
    expect(await screen.findByText(/targets another device class/)).toBeInTheDocument();
    status = 500;
    fireEvent.click(screen.getByRole("button", { name: "Load" }));
    expect(await screen.findByText("Load failed (500)")).toBeInTheDocument();
  });

  it("publishes a preset and refreshes, or reports forbidden and other failures", async () => {
    let status = 200;
    fetchMock.mockImplementation(async (_u: string, init?: any) => (init?.method === "POST" ? json(status) : json(200, [])));
    render(<BroadcastSwitcherDeck {...baseProps()} />);
    open();
    await screen.findByText("No published presets.");
    const publish = screen.getByRole("button", { name: "Publish" });
    expect(publish).toBeDisabled();
    fireEvent.change(screen.getByLabelText("New program console preset name"), { target: { value: "  " } });
    expect(publish).toBeDisabled();
    fireEvent.change(screen.getByLabelText("New program console preset name"), { target: { value: " Night " } });
    fireEvent.click(publish);
    expect(await screen.findByText("Console preset published.")).toBeInTheDocument();
    const post = fetchMock.mock.calls.find((c) => c[1]?.method === "POST")!;
    expect(JSON.parse(post[1].body)).toMatchObject({ name: "Night", scope: "program", scopeId: "prog 1", sourceDeviceClass: "tablet" });
    fireEvent.change(screen.getByLabelText("New program console preset name"), { target: { value: "Again" } });
    status = 403;
    fireEvent.click(publish);
    expect(await screen.findByText("You do not have permission to publish console presets.")).toBeInTheDocument();
    status = 500;
    fireEvent.click(publish);
    expect(await screen.findByText("Publish failed (500)")).toBeInTheDocument();
  });

  it("does nothing when publish is invoked with a blank name", async () => {
    fetchMock.mockResolvedValue(json(200, []));
    render(<BroadcastSwitcherDeck {...baseProps()} />);
    open();
    await screen.findByText("No published presets.");
    fireEvent.change(screen.getByLabelText("New program console preset name"), { target: { value: "x" } });
    const publish = screen.getByRole("button", { name: "Publish" });
    const props = Object.keys(publish).find((k) => k.startsWith("__reactProps"))!;
    fireEvent.change(screen.getByLabelText("New program console preset name"), { target: { value: " " } });
    (publish as any)[props].onClick();
    expect(fetchMock.mock.calls.every((c) => c[1]?.method !== "POST")).toBe(true);
  });

  it("retires a preset after confirmation and reports refusals", async () => {
    let status = 200;
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    fetchMock.mockImplementation(async (_u: string, init?: any) => (init?.method === "DELETE" ? json(status) : json(200, [layout])));
    render(<BroadcastSwitcherDeck {...baseProps()} />);
    open();
    await screen.findByText(/Night/);
    fireEvent.click(screen.getByRole("button", { name: "Retire" }));
    expect(fetchMock.mock.calls.every((c) => c[1]?.method !== "DELETE")).toBe(true);
    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: "Retire" }));
    expect(await screen.findByText("Retired Night.")).toBeInTheDocument();
    status = 403;
    fireEvent.click(screen.getByRole("button", { name: "Retire" }));
    expect(await screen.findByText("You do not have permission to retire console presets.")).toBeInTheDocument();
    status = 500;
    fireEvent.click(screen.getByRole("button", { name: "Retire" }));
    expect(await screen.findByText("Retire failed (500)")).toBeInTheDocument();
  });

  it("falls back to a generic message for a non-error rejection", async () => {
    fetchMock.mockRejectedValueOnce("offline");
    render(<BroadcastSwitcherDeck {...baseProps()} />);
    open();
    expect(await screen.findByText("Console presets unavailable")).toBeInTheDocument();
  });

  it("lists nothing for a team scope without a team id", async () => {
    mocks.features = { context: { authorization: {} } };
    fetchMock.mockResolvedValue(json(200, []));
    render(<BroadcastSwitcherDeck {...baseProps()} programId="" />);
    open();
    expect(await screen.findByText("No published presets.")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Publish" })).toBeDisabled();
  });

});
