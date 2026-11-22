import {
  cleanup,
  createEvent,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import {
  LabelsView,
  type LabelsViewAsset,
  type LabelsViewLabel,
  type LabelsViewProps,
} from "./LabelsView";

vi.mock("@gaulatti/bleecker", async (original) => {
  const kit = await import("../../../test/routeKit");
  return kit.nativeSelect(
    original as () => Promise<typeof import("@gaulatti/bleecker")>,
  );
});

// gaulatti/alcantara#288, part C: the Labels management table and its ordered drawer.

const NOW = new Date(2026, 10, 22, 15, 0);
const asset = (id: string, mediaType: string): LabelsViewAsset => ({
  id,
  name: `Asset ${id}`,
  mediaType,
  sourceUrl: `https://media.test/${id}`,
});
const label = (
  id: string,
  assets: LabelsViewAsset[],
  overrides: Partial<LabelsViewLabel> = {},
): LabelsViewLabel => ({
  id,
  name: id,
  description: null,
  assetCount: assets.length,
  updatedAt: new Date(2026, 10, 22, 9, 12).toISOString(),
  assets: assets.map((entry, position) => ({ position, asset: entry })),
  ...overrides,
});

const LABELS = [
  label("Evening", [asset("e1", "AUDIO")], {
    description: "Rotation after 19:00",
    updatedAt: new Date(2026, 10, 21, 10, 0).toISOString(),
  }),
  label(
    "Ninety",
    [asset("n1", "AUDIO"), asset("n2", "AUDIO"), asset("n3", "IMAGE"), asset("n4", "VIDEO")],
    { description: "Songs from the nineties" },
  ),
  label("Sponsor", [asset("s1", "IMAGE")], {
    assetCount: 4,
    updatedAt: new Date(2026, 9, 30, 10, 0).toISOString(),
  }),
];

afterEach(() => cleanup());

function setup(overrides: Partial<LabelsViewProps<LabelsViewLabel>> = {}) {
  const props: LabelsViewProps<LabelsViewLabel> = {
    labels: LABELS,
    loading: false,
    selectedId: null,
    onSelect: vi.fn(),
    search: "",
    onSearchChange: vi.fn(),
    onCreate: vi.fn(),
    onEdit: vi.fn(),
    onDelete: vi.fn(),
    addableAssets: [asset("x1", "AUDIO"), asset("n1", "AUDIO")],
    onAddAsset: vi.fn(async () => true),
    onRemoveAsset: vi.fn(async () => undefined),
    onReorder: vi.fn(async () => undefined),
    now: NOW,
    ...overrides,
  };
  const view = render(<LabelsView {...props} />);
  return { props, ...view };
}

const table = () => within(screen.getByRole("table"));
const rowOf = (name: string) => table().getByText(name).closest("tr")!;
const names = () =>
  table()
    .getAllByRole("row")
    .slice(1)
    .map((row) => row.querySelector("p")?.textContent);

it("shows each label's media mix, count and last change", () => {
  setup();
  const ninety = rowOf("Ninety");
  expect(ninety).toHaveTextContent("Songs from the nineties");
  expect(within(ninety).getByRole("img")).toHaveAttribute(
    "aria-label",
    "2 audio, 1 image, 1 video",
  );
  expect(within(ninety).getByTestId("mix-audio").style.width).toBe("50%");
  expect(within(ninety).getByTestId("mix-image").style.width).toBe("25%");
  expect(ninety.cells[2]).toHaveTextContent("4");
  expect(ninety.cells[3]).toHaveTextContent("Today 09:12");
  expect(rowOf("Evening").cells[3]).toHaveTextContent("Yesterday");
  expect(rowOf("Sponsor").cells[3]).toHaveTextContent("Oct 30");
  // The count is the label's, the mix is of the assets listed.
  expect(rowOf("Sponsor").cells[2]).toHaveTextContent("4");
});

it("says so when a label has no media", () => {
  setup({ labels: [label("Empty", [])] });
  expect(rowOf("Empty")).toHaveTextContent("No media");
});

it("sorts by most used, name or recent change, and searches names and descriptions", () => {
  const { props, rerender } = setup();
  expect(names()).toEqual(["Ninety", "Sponsor", "Evening"]);
  const sort = screen.getByRole("group", { name: "Sort" });
  fireEvent.click(within(sort).getByRole("button", { name: "A–Z" }));
  expect(names()).toEqual(["Evening", "Ninety", "Sponsor"]);
  fireEvent.click(within(sort).getByRole("button", { name: "Recently changed" }));
  expect(names()).toEqual(["Ninety", "Evening", "Sponsor"]);
  expect(
    within(sort).getByRole("button", { name: "Recently changed" }),
  ).toHaveAttribute("aria-pressed", "true");

  fireEvent.change(screen.getByPlaceholderText("Search labels…"), {
    target: { value: "nineties" },
  });
  expect(props.onSearchChange).toHaveBeenCalledWith("nineties");
  rerender(<LabelsView {...props} search="nineties" />);
  expect(names()).toEqual(["Ninety"]);
  rerender(<LabelsView {...props} search="zzz" />);
  expect(screen.getByText("No label matches the search.")).toBeInTheDocument();
});

it("selects a label by click or keyboard and offers New label", () => {
  const { props } = setup();
  fireEvent.click(rowOf("Evening"));
  expect(props.onSelect).toHaveBeenLastCalledWith("Evening");
  fireEvent.keyDown(rowOf("Sponsor"), { key: "Enter" });
  expect(props.onSelect).toHaveBeenLastCalledWith("Sponsor");
  fireEvent.keyDown(rowOf("Ninety"), { key: " " });
  expect(props.onSelect).toHaveBeenLastCalledWith("Ninety");
  fireEvent.keyDown(rowOf("Ninety"), { key: "a" });
  expect(props.onSelect).toHaveBeenCalledTimes(3);
  fireEvent.click(screen.getByRole("button", { name: "New label" }));
  expect(props.onCreate).toHaveBeenCalled();
  expect(screen.getByText("Select a label")).toBeInTheDocument();
});

it("shows a spinner while loading and an empty state with no labels", () => {
  const { rerender, props } = setup({ loading: true, labels: [] });
  expect(screen.queryByText("No labels yet")).toBeNull();
  rerender(<LabelsView {...props} loading={false} />);
  expect(screen.getByText("No labels yet")).toBeInTheDocument();
});

it("shows the selected label's counts and its media in stored order, with how many more there are", () => {
  setup({ selectedId: "Sponsor" });
  const drawer = within(
    screen.getByRole("complementary", { name: "Sponsor details" }),
  );
  expect(drawer.getByRole("heading", { name: "Sponsor" })).toBeInTheDocument();
  expect(drawer.getByText("MediaAssetLabel.position")).toBeInTheDocument();
  expect(drawer.getByText("of 4")).toBeInTheDocument();
  expect(drawer.getAllByRole("listitem")).toHaveLength(1);
  expect(drawer.getByText("and 3 more")).toBeInTheDocument();

  cleanup();
  setup({ selectedId: "Ninety" });
  const ninety = within(
    screen.getByRole("complementary", { name: "Ninety details" }),
  );
  expect(ninety.getAllByRole("listitem").map((item) => item.textContent)).toEqual([
    "1Asset n1audio",
    "2Asset n2audio",
    "3Asset n3image",
    "4Asset n4video",
  ]);
  expect(ninety.queryByText(/more$/)).toBeNull();
  // The audio count of the label.
  expect(
    ninety.getByText("Audio").parentElement,
  ).toHaveTextContent("2of 4");
});

it("rearranges the order by drag and drop, and ignores a drop in place", () => {
  const { props } = setup({ selectedId: "Ninety" });
  const item = (id: string) => screen.getByTestId(`order-${id}`);
  const dataTransfer = { effectAllowed: "", setData: vi.fn() };
  fireEvent.dragStart(item("n1"), { dataTransfer });
  expect(dataTransfer.setData).toHaveBeenCalledWith("text/plain", "n1");
  fireEvent.dragOver(item("n3"), { dataTransfer });
  const drop = createEvent.drop(item("n3"), { dataTransfer });
  fireEvent(item("n3"), drop);
  expect(drop.defaultPrevented).toBe(true);
  expect(props.onReorder).toHaveBeenCalledTimes(1);
  expect(props.onReorder).toHaveBeenCalledWith(
    expect.objectContaining({ id: "Ninety" }),
    ["n2", "n3", "n1", "n4"],
  );

  // Dropping on the item that was picked up changes nothing.
  fireEvent.dragStart(item("n2"), { dataTransfer });
  fireEvent.drop(item("n2"), { dataTransfer });
  // A drop with nothing being dragged changes nothing.
  fireEvent.drop(item("n4"), { dataTransfer });
  fireEvent.dragStart(item("n4"), { dataTransfer });
  fireEvent.dragEnd(item("n4"));
  fireEvent.drop(item("n1"), { dataTransfer });
  expect(props.onReorder).toHaveBeenCalledTimes(1);
});

it("moves, removes and renames with buttons, so the order can be changed from the keyboard", () => {
  const { props } = setup({ selectedId: "Ninety" });
  const drawer = within(
    screen.getByRole("complementary", { name: "Ninety details" }),
  );
  expect(drawer.getByRole("button", { name: "Move Asset n1 up" })).toBeDisabled();
  expect(drawer.getByRole("button", { name: "Move Asset n4 down" })).toBeDisabled();
  fireEvent.click(drawer.getByRole("button", { name: "Move Asset n2 up" }));
  expect(props.onReorder).toHaveBeenLastCalledWith(
    expect.objectContaining({ id: "Ninety" }),
    ["n2", "n1", "n3", "n4"],
  );
  fireEvent.click(drawer.getByRole("button", { name: "Move Asset n3 down" }));
  expect(props.onReorder).toHaveBeenLastCalledWith(
    expect.objectContaining({ id: "Ninety" }),
    ["n1", "n2", "n4", "n3"],
  );
  fireEvent.click(drawer.getByRole("button", { name: "Remove Asset n3 from Ninety" }));
  expect(props.onRemoveAsset).toHaveBeenCalledWith(
    expect.objectContaining({ id: "Ninety" }),
    "n3",
  );
  fireEvent.click(drawer.getByRole("button", { name: "Rename" }));
  expect(props.onEdit).toHaveBeenCalledWith(expect.objectContaining({ id: "Ninety" }));
  fireEvent.click(drawer.getByRole("button", { name: "Delete Ninety" }));
  expect(props.onDelete).toHaveBeenCalledWith(expect.objectContaining({ id: "Ninety" }));
});

it("adds an asset that is not in the label, and keeps the choice when the add fails", async () => {
  const onAddAsset = vi
    .fn()
    .mockResolvedValueOnce(false)
    .mockResolvedValueOnce(true);
  setup({ selectedId: "Ninety", onAddAsset });
  const drawer = within(
    screen.getByRole("complementary", { name: "Ninety details" }),
  );
  expect(drawer.queryByRole("combobox")).toBeNull();
  fireEvent.click(drawer.getByRole("button", { name: "Add assets" }));
  const chooser = drawer.getByRole("combobox") as HTMLSelectElement;
  // An asset the label already holds is not offered.
  expect(
    within(chooser)
      .getAllByRole("option")
      .map((option) => option.textContent),
  ).toEqual(["Choose media…", "Asset x1 · audio"]);
  expect(drawer.getByRole("button", { name: "Add" })).toBeDisabled();
  fireEvent.change(chooser, { target: { value: "x1" } });
  fireEvent.click(drawer.getByRole("button", { name: "Add" }));
  await waitFor(() => expect(onAddAsset).toHaveBeenCalledTimes(1));
  expect(onAddAsset).toHaveBeenCalledWith(
    expect.objectContaining({ id: "Ninety" }),
    "x1",
  );
  expect(chooser).toHaveValue("x1");
  fireEvent.click(drawer.getByRole("button", { name: "Add" }));
  await waitFor(() => expect(chooser).toHaveValue(""));
  fireEvent.click(drawer.getByRole("button", { name: "Add assets" }));
  expect(drawer.queryByRole("combobox")).toBeNull();
});

it("says when the selected label has no media", () => {
  setup({ selectedId: "Empty", labels: [label("Empty", [])] });
  expect(screen.getByText("No media with this label")).toBeInTheDocument();
});
