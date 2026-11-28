import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { ProgramTextSequenceEditor } from "./ProgramTextSequenceEditor";
import type { ProgramTextSequence } from "@modoitaliano/giorgia/scenes";

// gaulatti/alcantara#186: the nested text-sequence editor behind chyrons and
// lower thirds, driven the way a scene editor drives it.

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const leaf = (id: string, text: string, useMarquee?: boolean) => ({
  id,
  kind: "preset" as const,
  text,
  ...(useMarquee === undefined ? {} : { useMarquee }),
});
const block = (
  id: string,
  label: string,
  items: ProgramTextSequence["items"],
) => ({
  id,
  kind: "sequence" as const,
  label,
  sequence: {
    mode: "manual" as const,
    items,
    activeItemId: items[0]?.id ?? null,
  },
});

/** Holds the sequence like a scene editor does, and records every change. */
function Harness({
  initial,
  onTakeSelection,
  includeMarquee,
  changes,
}: {
  initial: ProgramTextSequence;
  onTakeSelection?: (next: ProgramTextSequence) => Promise<void> | void;
  includeMarquee?: boolean;
  changes: ProgramTextSequence[];
}) {
  const [sequence, setSequence] = useState(initial);
  return (
    <ProgramTextSequenceEditor
      sequence={sequence}
      includeMarquee={includeMarquee}
      textLabel="Headline"
      textPlaceholder="Main headline"
      onChange={(next) => {
        changes.push(next);
        setSequence(next);
      }}
      onTakeSelection={onTakeSelection}
    />
  );
}

function editor(
  initial: ProgramTextSequence,
  options: {
    onTakeSelection?: (next: ProgramTextSequence) => Promise<void> | void;
    includeMarquee?: boolean;
  } = {},
) {
  const changes: ProgramTextSequence[] = [];
  render(<Harness initial={initial} changes={changes} {...options} />);
  return { changes, last: () => changes[changes.length - 1] };
}

const root = (
  items: ProgramTextSequence["items"],
  extra: Partial<ProgramTextSequence> = {},
): ProgramTextSequence => ({
  mode: "manual",
  items,
  activeItemId: items[0]?.id ?? null,
  ...extra,
});

it("shows each top-level text as its own sequence, and edits its text and marquee", () => {
  const { last } = editor(root([leaf("a", "Breaking", false)]), {
    includeMarquee: true,
  });
  expect(screen.getByText("Nested sequence")).toBeInTheDocument();
  expect(screen.getAllByText("Nested Sequence")).toHaveLength(1);
  const headline = screen.getByPlaceholderText("Main headline");
  expect(headline).toHaveValue("Breaking");
  expect(screen.getByText("Headline")).toBeInTheDocument();
  fireEvent.change(headline, { target: { value: "Breaking news" } });
  const changed = last();
  expect(changed.items[0]).toMatchObject({
    id: "a",
    kind: "sequence",
    label: "Breaking",
  });
  expect((changed.items[0] as any).sequence.items[0]).toMatchObject({
    text: "Breaking news",
    useMarquee: false,
  });
  fireEvent.click(
    screen.getByRole("checkbox", { name: "Force marquee scrolling" }),
  );
  expect((last().items[0] as any).sequence.items[0].useMarquee).toBe(true);
});

it('labels a blank top-level text "Sequence" and offers no marquee without it', () => {
  editor(root([leaf("a", "  ")]));
  expect(
    screen.queryByRole("checkbox", { name: "Force marquee scrolling" }),
  ).toBeNull();
  fireEvent.change(screen.getByPlaceholderText("Main headline"), {
    target: { value: "x" },
  });
  expect(screen.getByPlaceholderText("Main headline")).toHaveValue("x");
});

it("adds, takes and removes items, keeping a valid active item", async () => {
  const onTakeSelection = vi.fn();
  const { last } = editor(
    root([
      block("one", "One", [leaf("one-a", "First")]),
      block("two", "Two", [leaf("two-a", "Second")]),
    ]),
    {
      onTakeSelection,
    },
  );
  const takes = () => screen.getAllByRole("button", { name: "Take" });
  // Top level: Take on the second block.
  await act(async () => {
    fireEvent.click(takes()[2]);
  });
  expect(last().activeItemId).toBe("two");
  expect(onTakeSelection).toHaveBeenLastCalledWith(
    expect.objectContaining({ activeItemId: "two" }),
  );

  // Removing the active block moves the selection to the first one left.
  const removes = () => screen.getAllByRole("button", { name: "Remove" });
  fireEvent.click(removes()[2]);
  expect(last().items.map((item) => item.id)).toEqual(["one"]);
  expect(last().activeItemId).toBe("one");

  const adds = screen.getAllByRole("button", { name: "+ Sequence" });
  fireEvent.click(adds[adds.length - 1]);
  expect(last().items).toHaveLength(2);
  expect(last().items[1].kind).toBe("sequence");
  expect(last().activeItemId).toBe("one");

  // Removing a block that is not active keeps the selection.
  fireEvent.click(removes()[removes().length - 2]);
  expect(last().activeItemId).toBe("one");
});

it("takes a nested item through its parent and reports the whole sequence", async () => {
  const onTakeSelection = vi.fn();
  const { last } = editor(
    root([
      block("one", "One", [leaf("one-a", "First"), leaf("one-b", "Second")]),
    ]),
    { onTakeSelection },
  );
  const nested = screen.getAllByRole("button", { name: "Take" });
  await act(async () => {
    fireEvent.click(nested[2]);
  });
  const sent = onTakeSelection.mock.lastCall![0] as ProgramTextSequence;
  expect((sent.items[0] as any).sequence.activeItemId).toBe("one-b");
  expect(last()).toEqual(expect.objectContaining({ activeItemId: "one" }));
});

it("takes without a take action, and empties a sequence down to its empty state", async () => {
  const { last } = editor(root([leaf("a", "Only")]));
  await act(async () => {
    fireEvent.click(screen.getAllByRole("button", { name: "Take" })[0]);
  });
  expect(last().activeItemId).toBe("a");
  fireEvent.click(screen.getAllByRole("button", { name: "Remove" })[0]);
  expect(last().items).toEqual([]);
  expect(last().activeItemId).toBeNull();
  expect(
    screen.getByText("This sequence is empty. Add items below."),
  ).toBeInTheDocument();
});

it("switches to autoplay with its interval and loop, and back to manual on the item showing", () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(10_000);
  const { last } = editor(root([leaf("a", "One"), leaf("b", "Two")]));
  fireEvent.click(screen.getAllByRole("button", { name: "Autoplay" })[0]);
  expect(last()).toMatchObject({ mode: "autoplay", startedAt: 10_000 });
  const interval = screen.getByRole("spinbutton");
  expect(interval).toHaveValue(4000);
  fireEvent.change(interval, { target: { value: "100" } });
  expect(last().intervalMs).toBe(500);
  fireEvent.change(interval, { target: { value: "" } });
  expect(last().intervalMs).toBe(4000);
  const loop = screen.getByRole("checkbox", { name: "Loop" });
  expect(loop).toBeChecked();
  fireEvent.click(loop);
  expect(last().loop).toBe(false);
  fireEvent.click(loop);
  // Four seconds later the second item is showing; Manual keeps it.
  act(() => {
    vi.advanceTimersByTime(4_250);
  });
  fireEvent.click(screen.getAllByRole("button", { name: "Manual" })[0]);
  expect(last()).toMatchObject({ mode: "manual", activeItemId: "b" });
});

it("keeps the selected item when switching to manual from manual", () => {
  const { last } = editor(
    root([leaf("a", "One"), leaf("b", "Two")], { activeItemId: "b" }),
  );
  fireEvent.click(screen.getAllByRole("button", { name: "Manual" })[0]);
  expect(last()).toMatchObject({ mode: "manual", activeItemId: "b" });
});

it("reorders items by drag and drop, ignoring a drop on itself or without a drag", () => {
  const { changes, last } = editor(
    root([leaf("a", "One"), leaf("b", "Two"), leaf("c", "Three")]),
  );
  const handles = () => screen.getAllByLabelText("Drag to reorder");
  const rowOf = (handle: HTMLElement) => handle.parentElement!.parentElement!;
  // Top-level rows are the first handle of each block.
  const top = () => handles().filter((_, index) => index % 2 === 0);
  fireEvent.dragStart(top()[0]);
  fireEvent.dragOver(rowOf(top()[2]));
  fireEvent.drop(rowOf(top()[2]));
  expect(last().items.map((item) => item.id)).toEqual(["b", "c", "a"]);
  const count = changes.length;
  fireEvent.dragStart(top()[1]);
  fireEvent.drop(rowOf(top()[1]));
  fireEvent.drop(rowOf(top()[0]));
  fireEvent.dragStart(top()[0]);
  fireEvent.dragEnd(top()[0]);
  fireEvent.drop(rowOf(top()[2]));
  expect(changes).toHaveLength(count);
});

it("falls back to an empty manual sequence for a malformed one", () => {
  render(
    <ProgramTextSequenceEditor
      // A saved value that is not a sequence object, as stored scene data can be.
      sequence={null as unknown as ProgramTextSequence}
      onChange={vi.fn()}
    />,
  );
  // The fallback starts with one blank text, shown as its own sequence.
  expect(screen.getByPlaceholderText("Text")).toHaveValue("");
  expect(screen.getAllByRole("button", { name: "Take" })).toHaveLength(2);
});

it("marks the item on air", () => {
  editor(root([leaf("a", "One"), leaf("b", "Two")], { activeItemId: "b" }));
  const rows = screen
    .getAllByLabelText("Drag to reorder")
    .map((handle) => handle.parentElement!.parentElement!);
  // Each top-level item and its nested copy have a handle: a, a-nested, b, b-nested.
  const [rowA, , rowB] = rows;
  expect(rowB.className).toContain("bg-sea/10");
  expect(rowA.className).not.toContain("bg-sea/10");
  expect(within(rowB).getByDisplayValue("Two")).toBeInTheDocument();
});

it("edits one of several items, takes a nested item beside another block, and adds to an empty sequence", async () => {
  const onTakeSelection = vi.fn();
  const { last } = editor(
    root(
      [
        block("one", "One", [leaf("one-a", "First")]),
        block("two", "Two", [leaf("two-a", "Second")]),
      ],
      { activeItemId: null },
    ),
    { onTakeSelection },
  );
  fireEvent.change(screen.getByDisplayValue("Second"), {
    target: { value: "Second, edited" },
  });
  expect((last().items[0] as any).sequence.items[0].text).toBe("First");
  expect((last().items[1] as any).sequence.items[0].text).toBe(
    "Second, edited",
  );
  const takes = screen.getAllByRole("button", { name: "Take" });
  await act(async () => {
    fireEvent.click(takes[3]);
  });
  const sent = onTakeSelection.mock.lastCall![0] as ProgramTextSequence;
  expect(sent.items.map((item) => item.id)).toEqual(["one", "two"]);
  expect((sent.items[0] as any).sequence.items[0].text).toBe("First");

  const removes = () => screen.getAllByRole("button", { name: "Remove" });
  fireEvent.click(removes()[0]);
  fireEvent.click(removes()[0]);
  expect(last().items).toEqual([]);
  const adds = screen.getAllByRole("button", { name: "+ Sequence" });
  fireEvent.click(adds[adds.length - 1]);
  expect(last().items).toHaveLength(1);
  expect(last().activeItemId).toBe(last().items[0].id);
});

it("switches an empty autoplay sequence back to manual with nothing selected", () => {
  const { last } = editor(root([], { mode: "autoplay", activeItemId: null }));
  fireEvent.click(screen.getByRole("button", { name: "Manual" }));
  expect(last()).toMatchObject({
    mode: "manual",
    activeItemId: null,
    items: [],
  });
});

it("shows the saved autoplay interval rather than the default", () => {
  // gaulatti/alcantara#186 group (c): a sequence saved with its own interval
  // opens with that interval on the operator's screen.
  const { last } = editor(
    root([leaf("a", "One"), leaf("b", "Two")], {
      mode: "autoplay",
      intervalMs: 2500,
    }),
  );
  expect(screen.getByRole("spinbutton")).toHaveValue(2500);
  expect(last()).toBeUndefined();
});

it("shows the default interval when the saved autoplay sequence has none", () => {
  // gaulatti/alcantara#186 group (c): the right-hand arm of the interval field.
  editor(root([leaf("a", "One"), leaf("b", "Two")], { mode: "autoplay" }));
  expect(screen.getByRole("spinbutton")).toHaveValue(4000);
});

it("keeps a marquee on a chyron that is wrapped while marquee is available", () => {
  // Marquee on: the wrapped item keeps the marquee it had.
  const { last } = editor(root([leaf("a", "Breaking", true)]), {
    includeMarquee: true,
  });
  fireEvent.change(screen.getByPlaceholderText("Main headline"), {
    target: { value: "Breaking news" },
  });
  expect((last().items[0] as any).sequence.items[0].useMarquee).toBe(true);
});

it("saves no marquee on a wrapped chyron when marquee is not available", () => {
  // Marquee off: nothing about marquee is saved on the wrapped item.
  const { last } = editor(root([leaf("a", "Breaking", true)]));
  fireEvent.change(screen.getByPlaceholderText("Main headline"), {
    target: { value: "Breaking news" },
  });
  expect((last().items[0] as any).sequence.items[0].useMarquee).toBeUndefined();
});

it("shows the default interval for an autoplay sequence that has none stored", () => {
  editor({ ...root([leaf("a", "One")]), mode: "autoplay", intervalMs: undefined });
  expect(screen.getByRole("spinbutton")).toHaveValue(4000);
});

it("shows the default 4000 ms interval for an autoplay sequence that stores none", () => {
  editor({ ...root([leaf("a", "One")]), mode: "autoplay" });
  expect(screen.getByRole("spinbutton")).toHaveValue(4000);
});

it("moves an item with its Move up and Move down buttons, which a touch screen can reach", () => {
  const { last } = editor(root([leaf("a", "One"), leaf("b", "Two"), leaf("c", "Three")]));
  expect(screen.getAllByRole("button", { name: "Move item 1 up" })[0]).toBeDisabled();
  fireEvent.click(screen.getAllByRole("button", { name: "Move item 1 down" })[0]);
  expect(last().items.map((item) => item.id)).toEqual(["b", "a", "c"]);
  fireEvent.click(screen.getAllByRole("button", { name: "Move item 3 up" })[0]);
  expect(last().items.map((item) => item.id)).toEqual(["b", "c", "a"]);
  expect(screen.getAllByRole("button", { name: "Move item 3 down" })[0]).toBeDisabled();
});
