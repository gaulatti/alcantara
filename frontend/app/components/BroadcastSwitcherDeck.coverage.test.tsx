import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BroadcastSwitcherDeck, ConfidenceMonitor } from "./BroadcastSwitcherDeck";

// gaulatti/alcantara#404 (group B): the program return's states on the Program monitor, the scene list's
// empty messages, the TAKE busy and empty-preview captions, and clearing an armed fade-to-black when the
// deck leaves the page.

const preferenceProfile = vi.hoisted(() => ({
  touchMode: false,
  shortcutsEnabled: false,
  dockWidth: 280,
}));
vi.mock("../contexts/ConsolePreferencesContext", () => ({
  useConsolePreferences: () => ({
    profile: preferenceProfile,
    updateProfile: vi.fn(),
    syncState: "synced",
    deviceClass: "desktop",
  }),
}));
vi.mock("../hooks/useFeatures", () => ({
  useFeatures: () => ({ context: {} }),
}));

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

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

const monitorProps = {
  label: "PROGRAM",
  tone: "program" as const,
  scene: null,
  src: "/program/test",
};

it("says the return is lost, with no frame yet, when the program's return has never sent a picture", () => {
  render(
    <ConfidenceMonitor
      {...monitorProps}
      returnSource={{ kind: "return", from: "Alana", connected: false, latencyMs: null, lastFrameAt: null }}
    />,
  );
  expect(screen.getByText("RETURN · FROM ALANA")).toBeInTheDocument();
  expect(screen.getByRole("alert")).toHaveTextContent("Signal lost · no frame yet");
  expect(screen.getByText("No return picture")).toBeInTheDocument();
});

it("says the return is frozen when its last frame is old, and keeps the picture label at the top", () => {
  render(
    <ConfidenceMonitor
      {...monitorProps}
      returnSource={{ kind: "return", from: "Alana", connected: true, latencyMs: null, lastFrameAt: Date.now() - 10_000 }}
    />,
  );
  expect(screen.getByRole("status")).toHaveTextContent(/Frozen · same frame for/);
  expect(screen.getByText("No return picture")).toHaveClass("items-start");
});

it("says a return with a long delay is delayed, and names how far behind it is", () => {
  render(
    <ConfidenceMonitor
      {...monitorProps}
      returnSource={{ kind: "return", from: "Alana", connected: true, latencyMs: 4_000, lastFrameAt: Date.now() }}
    />,
  );
  expect(document.querySelector('[data-state="delayed"]')).not.toBeNull();
  expect(document.querySelector(".switcher-return-behind")).not.toBeNull();
});

it("says the scene list is empty when no scene is assigned", () => {
  render(<BroadcastSwitcherDeck {...props} scenes={[]} workspace="director" />);
  expect(screen.getByText("No scenes assigned. Add scenes from the Library.")).toBeInTheDocument();
});

it("says no scene matches when the search finds none", () => {
  render(<BroadcastSwitcherDeck {...props} workspace="director" />);
  fireEvent.change(screen.getByLabelText("Search scenes"), { target: { value: "zzz-no-match" } });
  expect(screen.getByText("No scenes match your search.")).toBeInTheDocument();
});

it("shows that a TAKE is being saved, and asks for a source when nothing is staged", () => {
  const { rerender } = render(<BroadcastSwitcherDeck {...props} takeBusy workspace="director" />);
  expect(screen.getByText("Saving Preview and taking it to Program…")).toBeInTheDocument();
  rerender(<BroadcastSwitcherDeck {...props} stagedScene={null} workspace="director" />);
  expect(screen.getByText("Choose a source to prepare the next scene.")).toBeInTheDocument();
});

it("clears an armed fade-to-black when the deck is left", async () => {
  const clear = vi.spyOn(window, "clearTimeout");
  const view = render(<BroadcastSwitcherDeck {...props} workspace="director" />);
  fireEvent.click(screen.getByRole("button", { name: "Fade to black" }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: /^Fade to black: armed/ })).toBeInTheDocument(),
  );
  const before = clear.mock.calls.length;
  view.unmount();
  expect(clear.mock.calls.length).toBeGreaterThan(before);
});
