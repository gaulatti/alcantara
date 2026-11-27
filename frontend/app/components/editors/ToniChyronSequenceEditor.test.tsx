import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { ToniChyronSequenceEditor } from "./ToniChyronSequenceEditor";
import type { ToniChyronSequence } from "../../utils/toniChyronSequence";

// gaulatti/alcantara#186: the Toni chyron sequence editor, driven the way
// the Toni chyron fields drive it.

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
  items: ToniChyronSequence["items"],
): ToniChyronSequence["items"][number] => ({
  id,
  kind: "sequence",
  label,
  sequence: { mode: "manual", items, activeItemId: items[0]?.id ?? null },
});
const root = (
  items: ToniChyronSequence["items"],
  extra: Partial<ToniChyronSequence> = {},
): ToniChyronSequence => ({
  mode: "manual",
  items,
  activeItemId: items[0]?.id ?? null,
  ...extra,
});

function Harness({
  initial,
  onTakeSelection,
  changes,
}: {
  initial: ToniChyronSequence;
  onTakeSelection?: (next: ToniChyronSequence) => Promise<void> | void;
  changes: ToniChyronSequence[];
}) {
  const [sequence, setSequence] = useState(initial);
  return (
    <ToniChyronSequenceEditor
      sequence={sequence}
      onChange={(next) => {
        changes.push(next);
        setSequence(next);
      }}
      onTakeSelection={onTakeSelection}
    />
  );
}

function editor(
  initial: ToniChyronSequence,
  onTakeSelection?: (next: ToniChyronSequence) => Promise<void> | void,
) {
  const changes: ToniChyronSequence[] = [];
  render(
    <Harness
      initial={initial}
      changes={changes}
      onTakeSelection={onTakeSelection}
    />,
  );
  return { changes, last: () => changes[changes.length - 1] };
}

it("shows each top-level chyron as its own sequence, and edits its text and marquee", () => {
  const { last } = editor(
    root([leaf("a", "Ciao", true), leaf("b", "  ")], { activeItemId: null }),
  );
  expect(screen.getAllByText("Nested sequence")).toHaveLength(2);
  fireEvent.change(screen.getByDisplayValue("Ciao"), {
    target: { value: "Ciao a tutti" },
  });
  expect(last().items[0]).toMatchObject({
    id: "a",
    kind: "sequence",
    label: "Ciao",
  });
  expect((last().items[0] as any).sequence.items[0].text).toBe("Ciao a tutti");
  expect(last().items[1]).toMatchObject({ id: "b" });
  // Nothing was selected, so the first chyron becomes the selection.
  expect(last().activeItemId).toBe("a");
  const marquees = screen.getAllByRole("checkbox", {
    name: "Force marquee scrolling",
  });
  fireEvent.click(marquees[1]);
  expect((last().items[1] as any).sequence.items[0].useMarquee).toBe(true);
});

it("adds, takes and removes chyrons, keeping a valid active item", async () => {
  const onTakeSelection = vi.fn();
  const { last } = editor(
    root(
      [
        block("one", "One", [leaf("one-a", "First")]),
        block("two", "Two", [leaf("two-a", "Second")]),
      ],
      { activeItemId: null },
    ),
    onTakeSelection,
  );
  await act(async () => {
    fireEvent.click(screen.getAllByRole("button", { name: "Take" })[2]);
  });
  expect(last().activeItemId).toBe("two");
  expect(onTakeSelection).toHaveBeenLastCalledWith(
    expect.objectContaining({ activeItemId: "two" }),
  );
  // A nested take beside another block reports the whole sequence.
  await act(async () => {
    fireEvent.click(screen.getAllByRole("button", { name: "Take" })[1]);
  });
  const sent = onTakeSelection.mock.lastCall![0] as ToniChyronSequence;
  expect(sent.items.map((item) => item.id)).toEqual(["one", "two"]);

  const removes = () => screen.getAllByRole("button", { name: "Remove" });
  fireEvent.click(removes()[2]);
  expect(last().items.map((item) => item.id)).toEqual(["one"]);
  fireEvent.click(removes()[0]);
  expect(last().items).toEqual([]);
  expect(last().activeItemId).toBeNull();
  expect(
    screen.getByText("This sequence is empty. Add items below."),
  ).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "+ Sequence" }));
  expect(last().activeItemId).toBe(last().items[0].id);
  const adds = screen.getAllByRole("button", { name: "+ Sequence" });
  fireEvent.click(adds[adds.length - 1]);
  expect(last().items).toHaveLength(2);
  expect(last().activeItemId).toBe(last().items[0].id);
  fireEvent.click(removes()[2]);
  expect(last().activeItemId).toBe(last().items[0].id);
});

it("takes without a take action", async () => {
  const { last } = editor(
    root([leaf("a", "Only"), leaf("b", "Other")], { activeItemId: "b" }),
  );
  await act(async () => {
    fireEvent.click(screen.getAllByRole("button", { name: "Take" })[0]);
  });
  expect(last().activeItemId).toBe("a");
});

it("runs on autoplay with its interval and loop, and returns to manual on the chyron showing", () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(10_000);
  const { last } = editor(root([leaf("a", "One"), leaf("b", "Two")]));
  fireEvent.click(screen.getAllByRole("button", { name: "Autoplay" })[0]);
  const interval = screen.getByRole("spinbutton");
  expect(interval).toHaveValue(4000);
  fireEvent.change(interval, { target: { value: "100" } });
  expect(last().intervalMs).toBe(500);
  fireEvent.change(interval, { target: { value: "" } });
  expect(last().intervalMs).toBe(4000);
  const loop = screen.getByRole("checkbox", { name: "Loop" });
  fireEvent.click(loop);
  expect(last().loop).toBe(false);
  fireEvent.click(loop);
  act(() => {
    vi.advanceTimersByTime(4_250);
  });
  fireEvent.click(screen.getAllByRole("button", { name: "Manual" })[0]);
  expect(last()).toMatchObject({ mode: "manual", activeItemId: "b" });
});

it("keeps the selection when switching to manual, and with nothing showing", () => {
  const { last } = editor(
    root([leaf("a", "One"), leaf("b", "Two")], { activeItemId: "b" }),
  );
  fireEvent.click(screen.getAllByRole("button", { name: "Manual" })[0]);
  expect(last()).toMatchObject({ mode: "manual", activeItemId: "b" });
  cleanup();
  const empty = editor(root([], { mode: "autoplay", activeItemId: null }));
  fireEvent.click(screen.getByRole("button", { name: "Manual" }));
  expect(empty.last()).toMatchObject({ mode: "manual", activeItemId: null });
});

it("reorders chyrons by drag and drop, ignoring a drop on itself or without a drag", () => {
  const { changes, last } = editor(
    root([leaf("a", "One"), leaf("b", "Two"), leaf("c", "Three")], {
      activeItemId: "c",
    }),
  );
  const handles = () => screen.getAllByLabelText("Drag to reorder");
  const rowOf = (handle: HTMLElement) => handle.parentElement!.parentElement!;
  const top = () => handles().filter((_, index) => index % 2 === 0);
  expect(rowOf(top()[2]).className).toContain("bg-sea/10");
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

it("takes a nested chyron on an editor that has no take handler, keeping the change", async () => {
  const { last } = editor(
    root(
      [
        block("one", "One", [leaf("one-a", "First")]),
        block("two", "Two", [leaf("two-a", "Second")]),
      ],
      { activeItemId: null },
    ),
  );
  await act(async () => {
    fireEvent.click(screen.getAllByRole("button", { name: "Take" })[1]);
  });
  expect(last().activeItemId).toBeTruthy();
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
