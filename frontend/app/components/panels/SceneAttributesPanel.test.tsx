import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { SceneAttributesPanel } from "./SceneAttributesPanel";
// Radix positioning runs continuously in jsdom; keep Bleecker's string
// callback contract with a native select.
vi.mock("@gaulatti/bleecker", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@gaulatti/bleecker")>();
  return {
    ...actual,
    Select: ({ options, onChange, value, ...rest }: any) => (
      <select
        {...rest}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {options.map((option: any) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    ),
  };
});
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

// gaulatti/alcantara#186, group E4: the empty state, the scene heading, the
// background audio tab and the autosave footer.
it("asks for a staged scene before showing any attributes", () => {
  render(<SceneAttributesPanel {...props} selectedScene={null} />);
  expect(screen.getByText("Prepare the next scene")).toBeInTheDocument();
  expect(screen.queryByRole("tablist")).toBeNull();
});
it("names the staged scene and falls back to the component type without a catalog name", () => {
  const onUpdateProp = vi.fn();
  const { rerender } = render(
    <SceneAttributesPanel
      {...props}
      scenes={[{ id: 80, name: "Morning show" } as any]}
      componentTypes={[]}
      onUpdateProp={onUpdateProp}
    />,
  );
  expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent(
    "Prepare · Morning show",
  );
  expect(screen.getByRole("tab", { name: "player" })).toBeInTheDocument();
  expect(screen.getByRole("status")).toHaveTextContent("player is hidden.");
  expect(
    screen.queryByText(/FifthBell runtime settings are stored/),
  ).toBeNull();
  rerender(<SceneAttributesPanel {...props} activeProgramId="fifthbell" />);
  expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent(
    "Prepare · Selected scene",
  );
  expect(
    screen.getByText(/FifthBell runtime settings are stored/),
  ).toBeInTheDocument();
});
it("chooses, takes and stops the scene background audio", () => {
  const onCommitComponentProps = vi.fn();
  const onTakeSceneInstant = vi.fn();
  const onStopSceneInstant = vi.fn();
  const asset = { id: "a1", name: "Rain bed", enabled: true } as any;
  const audio = {
    ...props,
    editableSceneComponentEntries: [],
    backgroundAudioAssets: [
      asset,
      { id: "a2", name: "Retired bed", enabled: false } as any,
    ],
    sceneEditorProps: {
      sceneInstant: { assetId: "a0", instantId: 9, volume: 0.4 },
    },
    onCommitComponentProps,
    onTakeSceneInstant,
    onStopSceneInstant,
  };
  const { rerender } = render(<SceneAttributesPanel {...audio} />);
  const clip = screen.getByRole("combobox");
  expect(
    Array.from(clip.querySelectorAll("option")).map((o) => o.textContent),
  ).toEqual(["No background audio", "Rain bed"]);
  expect(
    screen.getByText("Select background audio, then press SAVE (or TAKE BG)."),
  ).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "TAKE BG" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "STOP BG" })).toBeDisabled();
  expect(screen.queryByText("Loading background audio…")).toBeNull();
  fireEvent.change(clip, { target: { value: "a1" } });
  expect(onCommitComponentProps).toHaveBeenLastCalledWith("sceneInstant", {
    assetId: "a1",
    instantId: null,
    volume: 0.4,
  });

  rerender(
    <SceneAttributesPanel
      {...audio}
      sceneEditorProps={{ sceneInstant: "corrupt" }}
      selectedBackgroundAudioAssetId="a1"
      selectedBackgroundAudioAsset={asset}
      selectedSceneInstantId={12}
      isLoadingBackgroundAudio
    />,
  );
  expect(screen.getByText("Loading background audio…")).toBeInTheDocument();
  expect(screen.getByText("Ready: Rain bed")).toBeInTheDocument();
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "" } });
  expect(onCommitComponentProps).toHaveBeenLastCalledWith("sceneInstant", {
    assetId: null,
    instantId: null,
  });
  fireEvent.click(screen.getByRole("button", { name: "TAKE BG" }));
  expect(onTakeSceneInstant).toHaveBeenCalledWith(80, 12, "a1");

  rerender(
    <SceneAttributesPanel
      {...audio}
      sceneEditorProps={{}}
      selectedBackgroundAudioAsset={asset}
      sceneInstantPlayback={{ isPlaying: true, instantName: "Thunder" } as any}
    />,
  );
  expect(screen.getByText("Playing: Thunder")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "STOP BG" }));
  expect(onStopSceneInstant).toHaveBeenCalledTimes(1);
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "a1" } });
  expect(onCommitComponentProps).toHaveBeenLastCalledWith("sceneInstant", {
    assetId: "a1",
    instantId: null,
  });

  rerender(
    <SceneAttributesPanel
      {...audio}
      sceneInstantPlayback={{ isPlaying: true } as any}
    />,
  );
  expect(screen.getByText("Playing: Scene instant")).toBeInTheDocument();
});
it("reports autosave progress and errors in the footer and saves on request", () => {
  const onSave = vi.fn();
  const { rerender } = render(
    <SceneAttributesPanel {...props} onSave={onSave} />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  expect(onSave).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("alert")).toBeNull();
  rerender(
    <SceneAttributesPanel
      {...props}
      onSave={onSave}
      sceneAttributeSaveError="Scene save failed"
    />,
  );
  expect(screen.getByRole("alert")).toHaveTextContent("Scene save failed");
  rerender(
    <SceneAttributesPanel
      {...props}
      onSave={onSave}
      isSavingSceneAttributes
      sceneAttributeSaveError="Scene save failed"
    />,
  );
  expect(screen.getByText("Autosaving scene attributes…")).toBeInTheDocument();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByRole("button", { name: "Saving…" })).toBeDisabled();
});
