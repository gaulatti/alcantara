import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { SceneAttributesPanel } from "./SceneAttributesPanel";
vi.mock("../editors", () => ({
  ComponentPropsFields: () => <p>Player fields</p>,
  ZIndexField: () => null,
}));
afterEach(cleanup);
const props = {
  selectedScene: 80,
  scenes: [],
  stagedIsOnAir: false,
  isSavingSceneAttributes: false,
  sceneAttributeSaveError: null,
  editableSceneComponentEntries: [["player", { show: false }]] as [
    string,
    any,
  ][],
  componentTypes: [{ type: "player", name: "Giorgia player", description: "" }],
  sceneEditorProps: {},
  selectedSceneInstantId: null,
  selectedBackgroundAudioAssetId: null,
  selectedBackgroundAudioAsset: null,
  sceneInstantPlayback: { isPlaying: false } as any,
  activeProgramId: "main",
  backgroundAudioAssets: [],
  isLoadingBackgroundAudio: false,
  songCatalog: [],
  mediaGroups: [],
  isLoadingMediaGroups: false,
  mediaLabels: [],
  isLoadingMediaLabels: false,
  onBlurCapture: vi.fn(),
  onSave: vi.fn(),
  onCommitComponentProps: vi.fn(),
  onUpdateProp: vi.fn(),
  onReplaceProps: vi.fn(),
  onSyncComponentProps: vi.fn(),
  onTakeSceneInstant: vi.fn(),
  onStopSceneInstant: vi.fn(),
};
it("identifies hidden players and restores them only through an explicit edit", () => {
  const onUpdateProp = vi.fn();
  render(<SceneAttributesPanel {...props} onUpdateProp={onUpdateProp} />);
  expect(screen.getByRole("status")).toHaveTextContent(
    "Giorgia player is hidden.",
  );
  expect(onUpdateProp).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Show component" }));
  expect(onUpdateProp).toHaveBeenCalledWith("player", "show", true);
});
it("opens component preparation when scene metadata arrives after hydration", () => {
  const { rerender } = render(
    <SceneAttributesPanel {...props} editableSceneComponentEntries={[]} />,
  );
  expect(screen.getByRole("tab", { name: "Background audio" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  rerender(<SceneAttributesPanel {...props} />);
  expect(screen.getByRole("tab", { name: "Giorgia player" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  expect(screen.getByText("Player fields")).toBeInTheDocument();
});
it("warns when edits affect the scene already on Program", () => {
  render(<SceneAttributesPanel {...props} stagedIsOnAir />);
  expect(
    screen.getByText("This scene is on Program. Saved changes appear live."),
  ).toBeInTheDocument();
});
