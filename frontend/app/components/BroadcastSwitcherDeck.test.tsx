import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { BroadcastSwitcherDeck } from "./BroadcastSwitcherDeck";

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
it("leaves the Audio workspace to its tools without a duplicate monitor", () => {
  render(<BroadcastSwitcherDeck {...props} workspace="audio" />);
  expect(
    screen.queryByTitle("PROGRAM confidence monitor"),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByTitle("PREVIEW confidence monitor"),
  ).not.toBeInTheDocument();
  expect(screen.queryByLabelText("Assigned scenes")).not.toBeInTheDocument();
  expect(screen.queryByText("SWITCHER")).not.toBeInTheDocument();
});
it.each(["director", "graphics"] as const)(
  "retains bounded previews and scene selection in %s",
  (workspace) => {
    render(<BroadcastSwitcherDeck {...props} workspace={workspace} />);
    expect(screen.getByTitle("PREVIEW confidence monitor")).toBeInTheDocument();
    expect(screen.getByLabelText("Assigned scenes")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Editable scene/ }),
    ).toBeInTheDocument();
  },
);

it("requires a deliberate second action before fading to black", () => {
  const onFadeToBlack = vi.fn();
  render(
    <BroadcastSwitcherDeck
      {...props}
      onFadeToBlack={onFadeToBlack}
      workspace="director"
    />,
  );

  // One click only arms (Bleecker ArmTake); the second press within the time takes.
  fireEvent.click(screen.getByRole("button", { name: "Fade to black" }));
  expect(onFadeToBlack).not.toHaveBeenCalled();
  fireEvent.click(
    screen.getByRole("button", { name: /^Fade to black: armed/ }),
  );
  expect(onFadeToBlack).toHaveBeenCalledTimes(1);
});

it("shows what is on air on the Program monitor, and when it is faded to black", () => {
  const { rerender } = render(
    <BroadcastSwitcherDeck {...props} workspace="director" />,
  );
  const program = () =>
    document.querySelector<HTMLElement>('[data-tone="program"]')!;
  const preview = () =>
    document.querySelector<HTMLElement>('[data-tone="preview"]')!;
  if (props.activeScene) {
    expect(program()).toHaveTextContent("On air");
  } else {
    expect(program()).not.toHaveTextContent("On air");
  }
  expect(preview()).not.toHaveTextContent("On air");

  rerender(
    <BroadcastSwitcherDeck {...props} workspace="director" fadeToBlack />,
  );
  expect(program()).toHaveTextContent("Faded to black");
  expect(program()).not.toHaveTextContent("On air");
  expect(screen.getByRole("button", { name: "RESTORE PROGRAM" })).toBeVisible();
  expect(screen.queryByRole("button", { name: "Fade to black" })).toBeNull();
});

it("shows the keyboard arm for fade to black, and uses console controls instead of native ones", () => {
  preferenceProfile.shortcutsEnabled = true;
  onTestFinished(() => {
    preferenceProfile.shortcutsEnabled = false;
  });
  const onFadeToBlack = vi.fn();
  render(
    <BroadcastSwitcherDeck
      {...props}
      onFadeToBlack={onFadeToBlack}
      workspace="director"
    />,
  );
  fireEvent.keyDown(window, { key: "b", altKey: true });
  expect(screen.getByText("Fade to black armed: Alt+B again")).toBeVisible();
  expect(onFadeToBlack).not.toHaveBeenCalled();
  fireEvent.keyDown(window, { key: "b", altKey: true });
  expect(onFadeToBlack).toHaveBeenCalledTimes(1);

  expect(document.querySelector("select")).toBeNull();
  expect(screen.getByRole("combobox", { name: "Transition" })).toBeVisible();
});

it("filters sources and stages without taking Program", async () => {
  const onStageScene = vi.fn();
  const onTake = vi.fn();
  render(
    <BroadcastSwitcherDeck
      {...props}
      scenes={[scene, { id: 2, name: "Giorgia player" } as any]}
      onStageScene={onStageScene}
      onTake={onTake}
      workspace="director"
    />,
  );
  fireEvent.change(screen.getByRole("textbox", { name: "Search scenes" }), {
    target: { value: "giorgia" },
  });
  expect(
    screen.queryByRole("button", { name: /Editable scene/ }),
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /Giorgia player/ }));
  await waitFor(() => expect(onStageScene).toHaveBeenCalledWith(2));
  expect(onTake).not.toHaveBeenCalled();
});
it("waits for staging to finish before TAKE", async () => {
  let finish!: () => void;
  const onStageScene = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const onTake = vi.fn();
  render(
    <BroadcastSwitcherDeck
      {...props}
      onStageScene={onStageScene}
      onTake={onTake}
      workspace="director"
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: /Editable scene/ }));
  fireEvent.click(screen.getByRole("button", { name: "TAKE TO PROGRAM" }));
  expect(onTake).not.toHaveBeenCalled();
  await waitFor(() => expect(onStageScene).toHaveBeenCalled());
  finish();
  await waitFor(() => expect(onTake).toHaveBeenCalledTimes(1));
});
it("blocks repeated TAKE and exposes the failure beside the controls", () => {
  render(
    <BroadcastSwitcherDeck
      {...props}
      takeBusy
      takeError="Scene save failed"
      workspace="director"
    />,
  );
  expect(screen.getByRole("button", { name: "TAKING…" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "CUT" })).toBeDisabled();
  expect(screen.getByRole("alert")).toHaveTextContent("Scene save failed");
});

it("does not TAKE the previous Preview when staging is rejected", async () => {
  const onTake = vi.fn();
  render(
    <BroadcastSwitcherDeck
      {...props}
      onStageScene={async () => false}
      onTake={onTake}
      workspace="director"
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: /Editable scene/ }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Could not prepare Preview",
  );
  fireEvent.click(screen.getByRole("button", { name: "TAKE TO PROGRAM" }));
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(onTake).not.toHaveBeenCalled();
});
