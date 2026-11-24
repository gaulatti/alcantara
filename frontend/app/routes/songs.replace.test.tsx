import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import SongsCatalog from "./songs";

// Replacing a song's audio from the Edit song dialog must upload the file
// just picked. It used to read the previous pick (none the first time), so
// the first replacement uploaded nothing.

const uploadFileToMediaBucket = vi.hoisted(() => vi.fn());
vi.mock("@gaulatti/bleecker", async (original) => {
  const kit = await import("../../test/routeKit");
  return kit.inlineMenus(
    original as () => Promise<typeof import("@gaulatti/bleecker")>,
  );
});
vi.mock("../services/uploads", () => ({ uploadFileToMediaBucket }));
vi.mock("../services/songs", () => ({
  fetchSongsPage: vi.fn(async () => ({
    data: [
      {
        id: 7,
        artist: "Artist",
        title: "Old take",
        audioUrl: "https://media.test/old.mp3",
        coverUrl: null,
        durationMs: 180000,
        earoneSongId: null,
        earoneRank: null,
        earoneSpins: null,
        enabled: true,
        intro: null,
      },
    ],
    meta: {
      total: 1,
      page: 1,
      limit: 50,
      totalPages: 1,
      catalogTotal: 1,
      catalogEnabled: 1,
      catalogTotalDurationMs: 180000,
      catalogKnownDurationCount: 1,
    },
  })),
}));
vi.mock("../services/instants", () => ({
  fetchInstants: vi.fn(async () => []),
}));
vi.mock("../utils/globalProgram", () => ({
  useGlobalProgramId: () => ["radio"],
}));

/** jsdom cannot read audio metadata: the duration reads as unknown. */
class SilentAudio {
  onloadedmetadata: (() => void) | null = null;
  onerror: (() => void) | null = null;
  preload = "";
  src = "";
  load() {
    queueMicrotask(() => this.onerror?.());
  }
}

beforeEach(() => {
  vi.stubGlobal("Audio", SilentAudio);
  URL.createObjectURL = vi.fn(() => "blob:song");
  URL.revokeObjectURL = vi.fn();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  uploadFileToMediaBucket.mockReset();
});

it("uploads the replacement file picked in the Edit song dialog", async () => {
  uploadFileToMediaBucket.mockImplementation(
    async (_kind: string, file: File) => ({
      url: `https://media.test/${file.name}`,
      metadata: { title: "New take" },
    }),
  );
  render(<SongsCatalog />);
  fireEvent.keyDown(
    await screen.findByRole("button", { name: "Actions for Artist - Old take" }),
    { key: "Enter" },
  );
  fireEvent.click(await screen.findByRole("menuitem", { name: "Edit" }));
  const dialog = await screen.findByRole("dialog", { name: "Edit song" });
  const picker = dialog.querySelector(
    'input[type="file"][accept="audio/*"]',
  ) as HTMLInputElement;
  const file = new File(["audio"], "new-take.mp3", { type: "audio/mpeg" });
  fireEvent.change(picker, { target: { files: [file] } });

  await waitFor(() =>
    expect(uploadFileToMediaBucket).toHaveBeenCalledWith("song", file),
  );
  expect(uploadFileToMediaBucket).toHaveBeenCalledTimes(1);
  await waitFor(() =>
    expect(
      within(dialog).getByPlaceholderText(
        "Uploaded automatically after song upload",
      ),
    ).toHaveValue("https://media.test/new-take.mp3"),
  );
  expect(within(dialog).getByText("Replace: new-take.mp3")).toBeInTheDocument();
});

// gaulatti/alcantara#404 (songs route, outside the #404 list): a replacement's metadata fills the edit dialog, and a
// refused replacement says so.
async function pickReplacement(name: string) {
  fireEvent.keyDown(
    await screen.findByRole("button", { name: "Actions for Artist - Old take" }),
    { key: "Enter" },
  );
  fireEvent.click(await screen.findByRole("menuitem", { name: "Edit" }));
  const dialog = await screen.findByRole("dialog", { name: "Edit song" });
  const picker = dialog.querySelector('input[type="file"][accept="audio/*"]') as HTMLInputElement;
  fireEvent.change(picker, { target: { files: [new File(["audio"], name, { type: "audio/mpeg" })] } });
  return dialog;
}

it("fills the edit dialog from a replacement's metadata: artist, cover and length", async () => {
  uploadFileToMediaBucket.mockResolvedValueOnce({
    url: "https://media.test/fictional.mp3",
    metadata: { artist: " Fictional artist ", coverUrl: "https://media.test/c.png", durationMs: 123_000 },
  });
  render(<SongsCatalog />);
  const dialog = await pickReplacement("fictional.mp3");
  await waitFor(() => expect(within(dialog).getByDisplayValue("Fictional artist")).toBeInTheDocument());
  expect(within(dialog).getByDisplayValue("https://media.test/c.png")).toBeInTheDocument();
  expect(within(dialog).getByDisplayValue("123000")).toBeInTheDocument();
});

it("says a replacement the upload refuses was not uploaded", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  uploadFileToMediaBucket.mockRejectedValueOnce(new Error("too big"));
  render(<SongsCatalog />);
  await pickReplacement("fictional.mp3");
  expect((await screen.findAllByText("Failed to upload song file.")).length).toBeGreaterThan(0);
});
