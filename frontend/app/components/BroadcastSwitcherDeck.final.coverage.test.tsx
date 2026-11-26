import type React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BroadcastSwitcherDeck, ConfidenceMonitor } from "./BroadcastSwitcherDeck";

// gaulatti/alcantara#404 (BroadcastSwitcherDeck final pass): a shared layout loads (and a refused one says why), the
// device class and the team scope change from the preferences panel, the native program monitor is used when the
// desktop host has one, Alt+B re-arms after its window, and a deck with no scene shows no on-air caption.

// The design system's Select is a native select here, as in the other deck suites.
vi.mock("@gaulatti/bleecker", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@gaulatti/bleecker")>();
  return {
    ...actual,
    Select: ({ options, onChange, value, ...rest }: any) => (
      <select {...rest} value={value} onChange={(event) => onChange(event.target.value)}>
        {options.map((option: any) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    ),
  };
});

const hostState = vi.hoisted(() => ({ host: null as null | { programMonitor: (props: { programId: string }) => React.ReactElement } }));
vi.mock("../platform/desktopHost", () => ({ getDesktopHost: () => hostState.host }));

const pref = vi.hoisted(() => ({
  profile: { touchMode: false, shortcutsEnabled: true, dockWidth: 280 },
  setDeviceClassOverride: vi.fn(),
  resetCurrent: vi.fn(),
  resetAll: vi.fn(),
  adoptAcknowledged: vi.fn(),
  updateProfile: vi.fn(),
  features: { teamId: undefined as string | undefined },
}));
vi.mock("../contexts/ConsolePreferencesContext", () => ({
  useConsolePreferences: () => ({
    profile: pref.profile,
    updateProfile: pref.updateProfile,
    syncState: "synced",
    deviceClass: "desktop",
    version: 1,
    setDeviceClassOverride: pref.setDeviceClassOverride,
    resetCurrent: pref.resetCurrent,
    resetAll: pref.resetAll,
    detectedDeviceClass: "desktop",
    adoptAcknowledged: pref.adoptAcknowledged,
  }),
}));
vi.mock("../hooks/useFeatures", () => ({
  useFeatures: () => ({ context: { authorization: { teamId: pref.features.teamId } } }),
}));

const scene = { id: 1, name: "Editable scene" } as any;
const props = {
  programId: "test",
  activeScene: scene,
  stagedScene: scene,
  scenes: [scene],
  transitionId: "cut",
  realtimeConnected: true,
  fadeToBlack: false,
  onWorkspaceChange: vi.fn(),
  onTransitionChange: vi.fn(),
  onStageScene: vi.fn(),
  onTake: vi.fn(),
  onCut: vi.fn(),
  onFadeToBlack: vi.fn(),
};

const layout = { id: "l1", name: "Fictional layout", version: 1, sourceDeviceClass: "desktop" };

beforeEach(() => {
  pref.features.teamId = undefined;
  hostState.host = null;
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (String(url).includes("/load")) {
      return init?.method === "POST" && pref.features.teamId === "refuse"
        ? new Response("", { status: 409 })
        : Response.json({ preference: { version: 2, profile: { shortcutsEnabled: false } } });
    }
    return Response.json([layout]);
  }));
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

async function openPreferences() {
  fireEvent.click(await screen.findByRole("button", { name: /desktop preferences/ }));
}

it("loads a shared layout and adopts its version", async () => {
  render(<BroadcastSwitcherDeck {...props} workspace="director" />);
  await openPreferences();
  fireEvent.click(await screen.findByRole("button", { name: "Load" }));
  await waitFor(() => expect(pref.adoptAcknowledged).toHaveBeenCalledWith(2, { shortcutsEnabled: false }));
  expect(await screen.findByText("Loaded Fictional layout.")).toBeInTheDocument();
}, 15000);

it("says why a shared layout was not loaded when the device class no longer matches", async () => {
  pref.features.teamId = "refuse";
  render(<BroadcastSwitcherDeck {...props} workspace="director" />);
  await openPreferences();
  fireEvent.click(await screen.findByRole("button", { name: "Load" }));
  expect(await screen.findByText(/This preset targets another device class/)).toBeInTheDocument();
  expect(pref.adoptAcknowledged).not.toHaveBeenCalled();
}, 15000);

it("sets the device class override from the preferences panel", async () => {
  render(<BroadcastSwitcherDeck {...props} workspace="director" />);
  await openPreferences();
  fireEvent.change(await screen.findByLabelText("Device class override"), { target: { value: "tablet" } });
  expect(pref.setDeviceClassOverride).toHaveBeenCalledWith("tablet");
}, 15000);

it("switches the layout scope to the team when the operator has one", async () => {
  pref.features.teamId = "team-1";
  render(<BroadcastSwitcherDeck {...props} workspace="director" />);
  await openPreferences();
  fireEvent.change(await screen.findByDisplayValue("This program"), { target: { value: "team" } });
  expect(screen.getByDisplayValue("My team")).toBeInTheDocument();
}, 15000);

it("shows the desktop host's own program monitor when it has one", () => {
  const Monitor = ({ programId }: { programId: string }) => <div>Native monitor {programId}</div>;
  hostState.host = { programMonitor: Monitor };
  render(<BroadcastSwitcherDeck {...props} workspace="director" />);
  expect(screen.getByText("Native monitor test")).toBeInTheDocument();
});

it("re-arms Alt+B after its window, and does not fade on the press that comes late", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    const onFadeToBlack = vi.fn();
    render(<BroadcastSwitcherDeck {...props} onFadeToBlack={onFadeToBlack} workspace="director" />);
    fireEvent.keyDown(window, { key: "b", code: "KeyB", altKey: true });
    expect(screen.getByText("Fade to black armed: Alt+B again")).toBeInTheDocument();
    await act(async () => {
      vi.advanceTimersByTime(3_100);
    });
    expect(screen.queryByText("Fade to black armed: Alt+B again")).toBeNull();
    expect(onFadeToBlack).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});

it("shows no on-air caption when no scene is on air and the program is not faded", () => {
  render(<BroadcastSwitcherDeck {...props} activeScene={null} workspace="director" />);
  expect(screen.queryByText("On air")).toBeNull();
});

it("clears an armed Alt+B when the deck leaves the page", () => {
  const clear = vi.spyOn(window, "clearTimeout");
  const view = render(<BroadcastSwitcherDeck {...props} workspace="director" />);
  fireEvent.keyDown(window, { key: "b", code: "KeyB", altKey: true });
  expect(screen.getByText("Fade to black armed: Alt+B again")).toBeInTheDocument();
  const before = clear.mock.calls.length;
  view.unmount();
  expect(clear.mock.calls.length).toBeGreaterThan(before);
});

it("says the shared layouts could not be listed when the list fails to load", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response("down", { status: 500 })));
  render(<BroadcastSwitcherDeck {...props} workspace="director" />);
  await openPreferences();
  expect(await screen.findByText("Console presets failed (500)")).toBeInTheDocument();
});

it("says a lost return's signal was lost since its last frame when it had one", () => {
  render(
    <ConfidenceMonitor
      label="PROGRAM"
      tone="program"
      scene={null}
      src="/program/test"
      returnSource={{ kind: "return", from: "Alana", connected: false, latencyMs: null, lastFrameAt: Date.now() - 5_000 }}
    />,
  );
  expect(screen.getByRole("alert")).toHaveTextContent(/Signal lost · .* since the last frame/);
});

it("uses the detected device class and resets the current or every preference from the panel", async () => {
  render(<BroadcastSwitcherDeck {...props} workspace="director" />);
  await openPreferences();
  fireEvent.click(await screen.findByRole("button", { name: /Use detected/ }));
  expect(pref.setDeviceClassOverride).toHaveBeenCalledWith(null);
  fireEvent.click(screen.getByRole("button", { name: "Reset class" }));
  expect(pref.resetCurrent).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "Reset all" }));
  expect(pref.resetAll).toHaveBeenCalledTimes(1);
}, 15000);

it("passes a chosen transition up to the deck", async () => {
  render(<BroadcastSwitcherDeck {...props} workspace="director" />);
  fireEvent.change(await screen.findByLabelText("Transition"), { target: { value: "crescendo-prism" } });
  expect(props.onTransitionChange).toHaveBeenCalledWith("crescendo-prism");
}, 15000);
