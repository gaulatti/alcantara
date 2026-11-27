import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { SongCatalogItem } from "../../models/broadcast";
import { PlaySongNow } from "./PlaySongNow";

// gaulatti/alcantara#404 (radio desk play-now, an on-air path): the guards a bad input or a refused
// command can reach. A search with no match does nothing on Enter; a refused queue or take reports why
// and keeps the dialog open; a library song with no length shows no clock.

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const leaf = (id: string, title: string, artist = "Artist") => ({
  kind: "preset" as const,
  id,
  title,
  artist,
  coverUrl: "",
  audioUrl: `https://media.test/${id}.mp3`,
  songId: Number(id.replace(/\D/g, "")) || undefined,
  durationMs: 200_000,
});

const library = (id: number, title: string, durationMs: number | null): SongCatalogItem => ({
  id,
  artist: "Library Artist",
  title,
  audioUrl: `https://media.test/lib-${id}.mp3`,
  coverUrl: null,
  durationMs,
  earoneSongId: null,
  earoneRank: null,
  earoneSpins: null,
  enabled: true,
});

function open(overrides: Partial<React.ComponentProps<typeof PlaySongNow>> = {}) {
  const props = {
    open: true,
    leaves: [leaf("s1", "Harbor Lights")],
    catalog: [] as SongCatalogItem[],
    onClose: vi.fn(),
    onCueNext: vi.fn(async () => undefined),
    onTakeNow: vi.fn(async () => undefined),
    ...overrides,
  };
  render(<PlaySongNow {...props} />);
  return props;
}

const typeQuery = (value: string) =>
  fireEvent.change(screen.getByRole("textbox", { name: "Search the rotation and the library" }), { target: { value } });

it("does nothing on Enter when the search has no match", () => {
  const props = open();
  typeQuery("zzz-no-such-song");
  expect(screen.queryAllByRole("option")).toHaveLength(0);
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Enter" });
  expect(props.onCueNext).not.toHaveBeenCalled();
  expect(props.onTakeNow).not.toHaveBeenCalled();
  expect(props.onClose).not.toHaveBeenCalled();
});

it("reports a refused queue with its own message and keeps the dialog open", async () => {
  const props = open({ onCueNext: vi.fn(async () => { throw new Error("The rotation is full."); }) });
  typeQuery("harbor");
  fireEvent.click(screen.getByRole("button", { name: "Cue next Harbor Lights" }));
  expect(await screen.findByText("The rotation is full.")).toBeVisible();
  expect(props.onCueNext).toHaveBeenCalledTimes(1);
  expect(props.onClose).not.toHaveBeenCalled();
});

it("reports a refusal that is not an error object with the plain fallback", async () => {
  const props = open({ onCueNext: vi.fn(async () => { throw "refused"; }) });
  typeQuery("harbor");
  fireEvent.click(screen.getByRole("button", { name: "Cue next Harbor Lights" }));
  expect(await screen.findByText("The song was not played")).toBeVisible();
  expect(props.onClose).not.toHaveBeenCalled();
});

it("keeps the dialog open when a take now is refused", async () => {
  const props = open({ onTakeNow: vi.fn(async () => { throw new Error("The studio is locked."); }) });
  typeQuery("harbor");
  fireEvent.click(screen.getByRole("button", { name: "Take now Harbor Lights" }));
  fireEvent.click(screen.getByRole("button", { name: "Confirm Harbor Lights" }));
  expect(await screen.findByText("The studio is locked.")).toBeVisible();
  await waitFor(() => expect(props.onTakeNow).toHaveBeenCalledTimes(1));
  expect(props.onClose).not.toHaveBeenCalled();
});

it("shows a library song with no length without a clock", () => {
  open({ catalog: [library(42, "Quiet Cut", null)] });
  typeQuery("quiet");
  const row = screen.getByRole("option", { name: /Quiet Cut/ });
  expect(row).toHaveTextContent("Library");
  expect(row.textContent).not.toMatch(/·\s*\d+:\d\d/);
});

it("moves the highlight with the arrow keys and with the pointer", () => {
  open({ leaves: [leaf("s1", "Harbor Lights"), leaf("s2", "Harbor Tides")] });
  typeQuery("Harbor");
  const options = screen.getAllByRole("option");
  expect(options[0]).toHaveAttribute("aria-selected", "true");
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "ArrowDown" });
  expect(options[1]).toHaveAttribute("aria-selected", "true");
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "ArrowUp" });
  expect(options[0]).toHaveAttribute("aria-selected", "true");
  fireEvent.mouseEnter(options[1]);
  expect(options[1]).toHaveAttribute("aria-selected", "true");
});

it("ignores other keys in the dialog", () => {
  const props = open();
  typeQuery("Harbor");
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "x" });
  expect(props.onCueNext).not.toHaveBeenCalled();
  expect(props.onTakeNow).not.toHaveBeenCalled();
  expect(props.onClose).not.toHaveBeenCalled();
});

it("closes from a button, for a screen with no Escape key", () => {
  const props = open();
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  expect(props.onClose).toHaveBeenCalledOnce();
});
