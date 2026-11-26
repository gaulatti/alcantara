import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProgramSongSequenceEditor } from "./ProgramSongSequenceEditor";

// Radix positioning runs continuously in jsdom; keep Bleecker's string
// callback contract with a native select.
vi.mock("@gaulatti/bleecker", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@gaulatti/bleecker")>();
  return {
    ...actual,
    Select: ({ options, onChange, value, placeholder, ...rest }: any) => (
      <select
        {...rest}
        aria-label={placeholder}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">{placeholder}</option>
        {options.map((option: any) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    ),
  };
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("ProgramSongSequenceEditor Play Next action", () => {
  it("queues the selected playlist item without changing the playlist", () => {
    const onChange = vi.fn();
    const onQueueItem = vi.fn();
    render(
      <ProgramSongSequenceEditor
        undoScope="test-program"
        sequence={{
          mode: "shuffle",
          loop: true,
          activeItemId: "song-1",
          items: [
            {
              id: "song-1",
              kind: "preset",
              title: "The queued song",
              artist: "Queue artist",
              coverUrl: "",
              audioUrl: "https://example.test/song.mp3",
            },
          ],
        }}
        view="queue"
        onChange={onChange}
        onQueueItem={onQueueItem}
      />,
    );

    fireEvent.click(screen.getByLabelText("Play The queued song next"));

    expect(onQueueItem).toHaveBeenCalledWith("song-1");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("marks a playlist song for high rotation", () => {
    const onChange = vi.fn();
    render(
      <ProgramSongSequenceEditor
        undoScope="test-program"
        sequence={{
          mode: "shuffle",
          loop: true,
          activeItemId: "song-1",
          items: [
            {
              id: "song-1",
              kind: "preset",
              title: "Favorite song",
              artist: "Favorite artist",
              coverUrl: "",
              audioUrl: "https://example.test/favorite.mp3",
            },
          ],
        }}
        view="queue"
        onChange={onChange}
      />,
    );

    fireEvent.click(
      screen.getByLabelText("Add Favorite song to high rotation"),
    );

    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        items: [expect.objectContaining({ id: "song-1", highRotation: true })],
      }),
    );
  });

  it("disables adding a thirteenth high rotation song", () => {
    const onChange = vi.fn();
    render(
      <ProgramSongSequenceEditor
        undoScope="test-program"
        sequence={{
          mode: "shuffle",
          loop: true,
          activeItemId: "song-1",
          items: [
            ...Array.from({ length: 12 }, (_, index) => ({
              id: `favorite-${index}`,
              kind: "preset" as const,
              highRotation: true,
              title: `Favorite ${index}`,
              artist: "Artist",
              coverUrl: "",
              audioUrl: `https://example.test/favorite-${index}.mp3`,
            })),
            {
              id: "normal",
              kind: "preset",
              title: "Normal song",
              artist: "Artist",
              coverUrl: "",
              audioUrl: "https://example.test/normal.mp3",
            },
          ],
        }}
        view="queue"
        onChange={onChange}
      />,
    );

    expect(
      screen.getByLabelText("Add Normal song to high rotation"),
    ).toBeDisabled();
    expect(onChange).not.toHaveBeenCalled();
  });
});

// gaulatti/alcantara#186, group E5: the playlist editor through its props:
// the queue rows, the active row, local preview, take, swap, remove, reorder,
// the catalog panel and its search.

type Song = {
  id: number;
  enabled: boolean;
  artist?: string;
  title?: string;
  coverUrl?: string;
  audioUrl?: string;
  durationMs?: number;
  earoneSongId?: string;
  earoneRank?: string;
  earoneSpins?: string;
};

const preset = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  kind: "preset" as const,
  title: `Title ${id}`,
  artist: `Artist ${id}`,
  coverUrl: "",
  audioUrl: `https://example.test/${id}.mp3`,
  ...extra,
});

function editor(props: Record<string, any>) {
  const onChange = vi.fn();
  const view = render(
    <ProgramSongSequenceEditor undoScope="test-program" onChange={onChange} {...(props as any)} />,
  );
  return { onChange, ...view };
}

const rows = () =>
  Array.from(document.querySelectorAll<HTMLElement>(".playlist-row"));
const activeRow = () =>
  rows().findIndex((row) => row.dataset.active === "true");

/** A stand-in for the browser's Audio element, which jsdom cannot play. */
class FakeAudio {
  static instances: FakeAudio[] = [];
  static playResult: () => Promise<void> = () => Promise.resolve();
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  pause = vi.fn();
  play = vi.fn(() => FakeAudio.playResult());
  constructor(public src: string) {
    FakeAudio.instances.push(this);
  }
}

function stubAudio(playResult: () => Promise<void> = () => Promise.resolve()) {
  FakeAudio.instances = [];
  FakeAudio.playResult = playResult;
  vi.stubGlobal("Audio", FakeAudio);
}

describe("ProgramSongSequenceEditor queue", () => {
  it("flattens a legacy nested sequence into one playlist and keeps the active song", () => {
    editor({
      sequence: {
        mode: "manual",
        activeItemId: "outer",
        items: [
          preset("a"),
          {
            id: "outer",
            kind: "sequence",
            label: "Old block",
            sequence: { mode: "manual", items: [preset("b"), preset("c")] },
          },
        ],
      },
      view: "queue",
    });
    expect(rows().map((row) => row.textContent)).toEqual([
      expect.stringContaining("Title a"),
      expect.stringContaining("Title b"),
      expect.stringContaining("Title c"),
    ]);
    // The active id named the nested block, which is gone: the first song is active.
    expect(activeRow()).toBe(0);
    expect(screen.queryByText(/Legacy nested sequence/)).toBeNull();
  });

  it("shows an empty playlist when the active id names an empty legacy block", () => {
    editor({
      sequence: {
        mode: "manual",
        activeItemId: "outer",
        items: [
          {
            id: "outer",
            kind: "sequence",
            label: "Old block",
            sequence: { items: [] },
          },
        ],
      },
      view: "queue",
    });
    expect(screen.getByText("Playlist is empty")).toBeInTheDocument();
  });

  it("shows an empty playlist, or an empty filler rotation, with its own hint", () => {
    for (const sequence of [
      null,
      { items: [] },
      { activeItemId: null, items: [] },
    ]) {
      editor({ sequence, view: "queue" });
      expect(screen.getByText("Playlist is empty")).toBeInTheDocument();
      expect(
        screen.getByText("Search and add songs from the catalog panel."),
      ).toBeInTheDocument();
      // A plain playlist in the queue view has no heading.
      expect(screen.queryByText("0 songs")).toBeNull();
      cleanup();
    }
    editor({
      sequence: { items: [] },
      view: "queue",
      rotationLabel: "Fillers",
    });
    expect(screen.getByText("Fillers is empty")).toBeInTheDocument();
    expect(
      screen.getByText("Use Add fillers to choose Library songs."),
    ).toBeInTheDocument();
    expect(screen.getByText("0 songs")).toBeInTheDocument();
  });

  it("heads the queue with the song count in the full view", () => {
    const { rerender, onChange } = editor({
      sequence: { items: [preset("a")] },
    });
    expect(screen.getByText("1 song")).toBeInTheDocument();
    rerender(
      <ProgramSongSequenceEditor
        undoScope="test-program"
        sequence={{ items: [preset("a"), preset("b")] } as any}
        onChange={onChange}
        depth={1}
      />,
    );
    expect(screen.getByText("2 songs")).toBeInTheDocument();
  });

  it("renders each row's cover, initial, duration and title", () => {
    editor({
      sequence: {
        mode: "manual",
        activeItemId: null,
        items: [
          preset("a", {
            coverUrl: " https://example.test/a.jpg ",
            durationMs: 185000,
          }),
          preset("b", { title: "  ", artist: "", durationMs: 0 }),
          preset("c", { title: "zebra", durationMs: 59600 }),
          preset("d", { durationMs: Number.NaN }),
        ],
      },
      view: "queue",
    });
    const [a, b, c, d] = rows();
    expect(within(a).getByRole("img")).toHaveAttribute(
      "src",
      "https://example.test/a.jpg",
    );
    expect(within(a).getByRole("img")).toHaveAttribute(
      "alt",
      "Artist a - Title a",
    );
    expect(a).toHaveTextContent("3:05");
    expect(b).toHaveTextContent("?");
    expect(b).toHaveTextContent("—");
    expect(
      within(b).getByLabelText("Add song to high rotation"),
    ).toBeInTheDocument();
    expect(c).toHaveTextContent("Z");
    expect(c).toHaveTextContent("1:00");
    expect(d).toHaveTextContent("—");
    expect(activeRow()).toBe(-1);
  });

  it("marks the row that is playing on Program, by its token or its unique audio", () => {
    const sequence = {
      mode: "manual",
      activeItemId: "a",
      items: [
        preset("a"),
        preset("b"),
        preset("c", { audioUrl: "https://example.test/b.mp3" }),
      ],
    };
    const { rerender, onChange } = editor({
      sequence,
      view: "queue",
      programSongPlayback: { isPlaying: true, token: "b:42", audioUrl: "" },
    });
    expect(activeRow()).toBe(1);
    const show = (programSongPlayback: any) =>
      rerender(
        <ProgramSongSequenceEditor
        undoScope="test-program"
          sequence={sequence as any}
          view="queue"
          onChange={onChange}
          programSongPlayback={programSongPlayback}
        />,
      );
    show({ isPlaying: true, audioUrl: "https://example.test/a.mp3" });
    expect(activeRow()).toBe(0);
    // Two rows share the playing audio: neither is marked.
    show({
      isPlaying: true,
      token: "zzz:1",
      audioUrl: "https://example.test/b.mp3",
    });
    expect(activeRow()).toBe(-1);
    show({ isPlaying: false, token: "b:1" });
    expect(activeRow()).toBe(0);
  });

  it("takes a row on air through onTakeSelection, or as a plain change without it", () => {
    vi.spyOn(Date, "now").mockReturnValue(1_000);
    const onTakeSelection = vi.fn();
    const sequence = {
      mode: "manual",
      activeItemId: "a",
      items: [preset("a"), preset("b")],
    };
    const { onChange } = editor({ sequence, view: "queue", onTakeSelection });
    fireEvent.click(within(rows()[1]).getByLabelText("Take on air"));
    expect(onTakeSelection).toHaveBeenCalledWith(
      expect.objectContaining({ activeItemId: "b", startedAt: 1_000 }),
    );
    expect(onChange).not.toHaveBeenCalled();
    cleanup();
    const plain = editor({ sequence, view: "queue" });
    fireEvent.click(within(rows()[1]).getByLabelText("Take on air"));
    expect(plain.onChange).toHaveBeenCalledWith(
      expect.objectContaining({ activeItemId: "b", startedAt: 1_000 }),
    );
  });

  it("names an untitled row generically in its Play next action", () => {
    const onQueueItem = vi.fn();
    editor({
      sequence: { items: [preset("a", { title: "" })] },
      view: "queue",
      onQueueItem,
    });
    fireEvent.click(screen.getByLabelText("Play song next"));
    expect(onQueueItem).toHaveBeenCalledWith("a");
  });

  it("removes a song from high rotation", () => {
    const { onChange } = editor({
      sequence: { items: [preset("a", { highRotation: true })] },
      view: "queue",
    });
    expect(screen.getByText("Title · High rotation 1/12")).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Remove Title a from high rotation"));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        items: [expect.objectContaining({ id: "a", highRotation: false })],
      }),
    );
  });

  it("reorders by dragging a row's handle onto another row", () => {
    const { onChange } = editor({
      sequence: {
        mode: "manual",
        activeItemId: "a",
        items: [preset("a"), preset("b"), preset("c")],
      },
      view: "queue",
    });
    const targets = rows().map((row) => row.parentElement as HTMLElement);
    // A drop without a drag, and a drop on the dragged row, change nothing.
    fireEvent.dragOver(targets[1]);
    fireEvent.drop(targets[1]);
    fireEvent.dragStart(within(rows()[0]).getByLabelText("Drag to reorder"));
    fireEvent.drop(targets[0]);
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.dragStart(within(rows()[0]).getByLabelText("Drag to reorder"));
    fireEvent.drop(targets[2]);
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        items: [
          expect.objectContaining({ id: "b" }),
          expect.objectContaining({ id: "c" }),
          expect.objectContaining({ id: "a" }),
        ],
      }),
    );
    fireEvent.dragStart(within(rows()[1]).getByLabelText("Drag to reorder"));
    fireEvent.dragEnd(within(rows()[1]).getByLabelText("Drag to reorder"));
    fireEvent.drop(targets[0]);
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});

describe("ProgramSongSequenceEditor remove", () => {
  const ids = (sequence: any) => sequence.items.map((item: any) => item.id);

  it("moves the active song to the next one when the active row is removed", () => {
    vi.spyOn(Date, "now").mockReturnValue(5_000);
    const { onChange } = editor({
      sequence: {
        mode: "manual",
        activeItemId: "c",
        items: [preset("a"), preset("b"), preset("c")],
      },
      view: "queue",
    });
    fireEvent.click(within(rows()[2]).getByLabelText("Remove"));
    const next = onChange.mock.lastCall![0];
    expect(ids(next)).toEqual(["a", "b"]);
    expect(next.activeItemId).toBe("b");
    expect(next.startedAt).toBe(5_000);
  });

  it("keeps the active song when another row is removed, and clears it with the last song", () => {
    const { onChange, rerender } = editor({
      sequence: {
        mode: "manual",
        activeItemId: "b",
        items: [preset("a"), preset("b")],
      },
      view: "queue",
    });
    fireEvent.click(within(rows()[0]).getByLabelText("Remove"));
    expect(onChange.mock.lastCall![0]).toMatchObject({ activeItemId: "b" });
    rerender(
      <ProgramSongSequenceEditor
        undoScope="test-program"
        sequence={
          { mode: "manual", activeItemId: "a", items: [preset("a")] } as any
        }
        view="queue"
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByLabelText("Remove"));
    expect(onChange.mock.lastCall![0]).toMatchObject({
      items: [],
      activeItemId: null,
    });
  });

  it("falls back to the first song when nothing is active and another row is removed", () => {
    // A playing song that matches no row leaves no active song.
    const { onChange } = editor({
      sequence: {
        mode: "manual",
        activeItemId: "a",
        items: [preset("a"), preset("b"), preset("c")],
      },
      view: "queue",
      programSongPlayback: {
        isPlaying: true,
        token: "x:1",
        audioUrl: "https://elsewhere.test/x.mp3",
      },
    });
    fireEvent.click(within(rows()[1]).getByLabelText("Remove"));
    expect(onChange.mock.lastCall![0]).toMatchObject({ activeItemId: "a" });
  });

  it("keeps an autoplay clock in step with what Program is playing when another row is removed", () => {
    vi.spyOn(Date, "now").mockReturnValue(100_000);
    const sequence = {
      mode: "autoplay",
      activeItemId: "b",
      items: [preset("a"), preset("b"), preset("c")],
    };
    const removeFirst = (programSongPlayback: any, seq: any = sequence) => {
      const { onChange } = editor({
        sequence: seq,
        view: "queue",
        programSongPlayback,
      });
      fireEvent.click(within(rows()[0]).getByLabelText("Remove"));
      const next = onChange.mock.lastCall![0];
      cleanup();
      return next;
    };
    // Playing b by its audio, 30.4 seconds in: the clock starts that far back.
    expect(
      removeFirst({
        isPlaying: true,
        audioUrl: " https://example.test/b.mp3 ",
        currentTimeMs: 30_400.4,
      }).startedAt,
    ).toBe(69_600);
    // Matched by its token, with a negative position clamped to zero.
    expect(
      removeFirst({ isPlaying: false, token: "b:9", currentTimeMs: -5 })
        .startedAt,
    ).toBe(100_000);
    // No playback state, or playback of another song, restarts the clock now.
    expect(removeFirst(null).startedAt).toBe(100_000);
    expect(
      removeFirst({
        isPlaying: false,
        audioUrl: "https://example.test/c.mp3",
        currentTimeMs: 9_000,
      }).startedAt,
    ).toBe(100_000);
    // The active song has no audio and Program plays nothing it can match.
    expect(
      removeFirst(
        { isPlaying: false, token: "", currentTimeMs: 9_000 },
        {
          mode: "autoplay",
          activeItemId: "b",
          items: [preset("a"), preset("b", { audioUrl: "" })],
        },
      ).startedAt,
    ).toBe(100_000);
    // Shuffle with no active song and nothing playing.
    expect(
      removeFirst(
        { isPlaying: false, currentTimeMs: 9_000 },
        {
          mode: "shuffle",
          activeItemId: null,
          items: [preset("a"), preset("b")],
        },
      ).startedAt,
    ).toBe(100_000);
  });
});

describe("ProgramSongSequenceEditor local preview", () => {
  it("plays a song locally, stops it on a second press, and stops it on unmount", async () => {
    stubAudio();
    const { unmount } = editor({
      sequence: { items: [preset("a"), preset("b", { audioUrl: "  " })] },
      view: "queue",
    });
    expect(within(rows()[1]).getByLabelText("Preview locally")).toBeDisabled();
    await act(async () =>
      fireEvent.click(within(rows()[0]).getByLabelText("Preview locally")),
    );
    const [first] = FakeAudio.instances;
    expect(first.src).toBe("https://example.test/a.mp3");
    expect(first.play).toHaveBeenCalledTimes(1);
    await act(async () =>
      fireEvent.click(screen.getByLabelText("Stop local preview")),
    );
    expect(first.pause).toHaveBeenCalled();
    expect(screen.queryByLabelText("Stop local preview")).toBeNull();

    await act(async () =>
      fireEvent.click(within(rows()[0]).getByLabelText("Preview locally")),
    );
    const second = FakeAudio.instances[1];
    unmount();
    expect(second.pause).toHaveBeenCalled();
  });

  it("switches the preview to another song and clears it when the song ends or fails", async () => {
    stubAudio();
    editor({ sequence: { items: [preset("a"), preset("b")] }, view: "queue" });
    await act(async () =>
      fireEvent.click(within(rows()[0]).getByLabelText("Preview locally")),
    );
    await act(async () =>
      fireEvent.click(within(rows()[1]).getByLabelText("Preview locally")),
    );
    const [a, b] = FakeAudio.instances;
    expect(a.pause).toHaveBeenCalled();
    expect(
      within(rows()[1]).getByLabelText("Stop local preview"),
    ).toBeInTheDocument();
    // The replaced audio ending or failing does not touch the current preview.
    act(() => a.onended?.());
    act(() => a.onerror?.());
    expect(
      within(rows()[1]).getByLabelText("Stop local preview"),
    ).toBeInTheDocument();
    act(() => b.onended?.());
    expect(screen.queryByLabelText("Stop local preview")).toBeNull();

    await act(async () =>
      fireEvent.click(within(rows()[0]).getByLabelText("Preview locally")),
    );
    act(() => FakeAudio.instances[2].onerror?.());
    expect(screen.queryByLabelText("Stop local preview")).toBeNull();
  });

  it("reports a preview the browser refuses to play, and ignores a refusal that arrives too late", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const refusal = new Error("NotAllowedError");
    stubAudio(() => Promise.reject(refusal));
    editor({ sequence: { items: [preset("a"), preset("b")] }, view: "queue" });
    await act(async () =>
      fireEvent.click(within(rows()[0]).getByLabelText("Preview locally")),
    );
    expect(errors).toHaveBeenCalledWith(
      "Failed to play local song preview:",
      refusal,
    );
    expect(screen.queryByLabelText("Stop local preview")).toBeNull();

    // a's play settles only after b's preview has replaced it.
    let settleA: (() => void) | null = null;
    let rejectA: ((error: Error) => void) | null = null;
    FakeAudio.playResult = () =>
      new Promise<void>((resolve, reject) => {
        settleA = resolve;
        rejectA = reject;
      });
    await act(async () =>
      fireEvent.click(within(rows()[0]).getByLabelText("Preview locally")),
    );
    const settleFirst = settleA!;
    FakeAudio.playResult = () =>
      new Promise<void>((_resolve, reject) => {
        rejectA = reject;
      });
    await act(async () =>
      fireEvent.click(within(rows()[1]).getByLabelText("Preview locally")),
    );
    const rejectSecond = rejectA!;
    await act(async () => settleFirst());
    expect(screen.queryByLabelText("Stop local preview")).toBeNull();
    // b is replaced by a fresh preview of a, then b's play is refused late.
    FakeAudio.playResult = () => Promise.resolve();
    await act(async () =>
      fireEvent.click(within(rows()[0]).getByLabelText("Preview locally")),
    );
    await act(async () => rejectSecond(refusal));
    expect(
      within(rows()[0]).getByLabelText("Stop local preview"),
    ).toBeInTheDocument();
  });
});

describe("ProgramSongSequenceEditor catalog", () => {
  const catalog: Song[] = [
    {
      id: 3,
      enabled: true,
      artist: "Zeta",
      title: "Last",
      audioUrl: "https://example.test/3.mp3",
      coverUrl: "https://example.test/3.jpg",
      durationMs: 200_400,
      earoneSongId: "e3",
      earoneRank: "1",
      earoneSpins: "99",
    },
    {
      id: 1,
      enabled: true,
      artist: "Alpha",
      title: "",
      audioUrl: "https://example.test/1.mp3",
    },
    {
      id: 2,
      enabled: true,
      title: "Beta tune",
      audioUrl: "https://example.test/2.mp3",
      durationMs: -1,
    },
    {
      id: 4,
      enabled: false,
      artist: "Off",
      title: "Disabled",
      audioUrl: "https://example.test/4.mp3",
    },
    { id: 5, enabled: true, artist: "No", title: "Audio", audioUrl: "   " },
    { id: 6, enabled: true, audioUrl: "https://example.test/6.mp3" },
  ];
  const ADD = /^Add .+ to the playlist$/;
  const catalogRows = () =>
    screen
      .getAllByLabelText(ADD)
      .map((button) => button.parentElement as HTMLElement);

  it("will not add a song the playlist already holds (#280)", () => {
    editor({
      sequence: { items: [{ ...preset("held"), songId: 1 }] },
      songCatalog: catalog,
      view: "catalog",
    });
    expect(screen.getAllByLabelText(ADD)).toHaveLength(3);
    const held = screen.getByLabelText("Already in the playlist");
    expect(held).toBeDisabled();
    fireEvent.click(held);
  });

  // Walk part 4: the add button was hidden until hover (unusable on a touch screen) while a song already in the
  // playlist showed Bleecker's filled disabled button, and it was labelled "Add to queue" though it adds to the
  // playlist.
  it("shows every add button without hover, names the song and the playlist, and marks a held song with a check", () => {
    editor({
      sequence: { items: [{ ...preset("held"), songId: 1 }] },
      songCatalog: catalog,
      view: "catalog",
    });
    const add = screen.getByLabelText("Add Beta tune to the playlist");
    expect(add).toBeEnabled();
    expect(add.className).not.toMatch(/(^|\s)opacity-0(\s|$)/);
    expect(add.querySelector(".lucide-plus")).not.toBeNull();
    expect(screen.getByLabelText("Add song to the playlist")).toBeEnabled();
    const held = screen.getByLabelText("Already in the playlist");
    expect(held.className).toMatch(/disabled:bg-transparent/);
    expect(held.querySelector(".lucide-check")).not.toBeNull();
    expect(held.querySelector(".lucide-plus")).toBeNull();
  });

  // Walk part 4: on a phone the catalog beside the playlist was "hidden md:flex", so Add fillers showed nothing.
  it("keeps the catalog shown below the playlist on a phone, beside it from 768 px", () => {
    editor({ sequence: { items: [] }, songCatalog: catalog, view: "full" });
    const column = screen
      .getByPlaceholderText("Search catalog to add...")
      .closest("div.flex-col") as HTMLElement;
    expect(column.className).not.toMatch(/(^|\s)hidden(\s|$)/);
    expect(column.className).toMatch(/(^|\s)w-full(\s|$)/);
    expect(column.className).toMatch(/md:w-\[320px\]/);
  });

  it("lists only enabled songs with audio, sorted by artist and title, and searches them", () => {
    editor({ sequence: { items: [] }, songCatalog: catalog, view: "catalog" });
    expect(screen.queryByText("Playlist is empty")).toBeNull();
    const listed = catalogRows();
    expect(listed.map((row) => row.textContent)).toEqual([
      "",
      "Alpha",
      "BBeta tune",
      "LastZeta",
    ]);
    expect(listed[3].querySelector("img")).toHaveAttribute(
      "src",
      "https://example.test/3.jpg",
    );
    const search = screen.getByPlaceholderText("Search catalog to add...");
    fireEvent.change(search, { target: { value: "ALP" } });
    expect(catalogRows()).toHaveLength(1);
    fireEvent.change(search, { target: { value: "tune" } });
    expect(catalogRows()[0]).toHaveTextContent("Beta tune");
    fireEvent.change(search, { target: { value: "nothing like it" } });
    expect(screen.queryAllByLabelText(ADD)).toHaveLength(0);
    expect(screen.getByText("No matches found")).toBeInTheDocument();
    cleanup();
    editor({ sequence: { items: [] }, songCatalog: [], view: "catalog" });
    expect(screen.queryByText("No matches found")).toBeNull();
  });

  it("adds a catalog song with its details, keeping the active song", () => {
    vi.spyOn(Date, "now").mockReturnValue(10);
    const add = (sequence: any, title: string) => {
      const { onChange } = editor({
        sequence,
        songCatalog: catalog,
        view: "full",
      });
      fireEvent.click(
        within(
          catalogRows().find((row) => row.textContent?.includes(title))!,
        ).getByLabelText(ADD),
      );
      const next = onChange.mock.lastCall![0];
      cleanup();
      return next;
    };
    let next = add(
      { mode: "manual", activeItemId: "a", items: [preset("a")] },
      "Last",
    );
    expect(next.activeItemId).toBe("a");
    expect(next.items[1]).toMatchObject({
      kind: "preset",
      songId: 3,
      artist: "Zeta",
      title: "Last",
      coverUrl: "https://example.test/3.jpg",
      audioUrl: "https://example.test/3.mp3",
      durationMs: 200_400,
      earoneSongId: "e3",
      earoneRank: "1",
      earoneSpins: "99",
    });
    next = add({ mode: "manual", activeItemId: null, items: [] }, "Beta tune");
    expect(next.activeItemId).toBeNull();
    expect(next.items[0]).toMatchObject({
      songId: 2,
      artist: "",
      title: "Beta tune",
      coverUrl: "",
      durationMs: undefined,
    });
    // An automatic playlist with nothing active starts on the added song.
    next = add({ mode: "autoplay", activeItemId: null, items: [] }, "Alpha");
    expect(next.activeItemId).toBe(next.items[0].id);
    next = add(
      { mode: "shuffle", activeItemId: "a", items: [preset("a")] },
      "Alpha",
    );
    expect(next.activeItemId).toBe("a");
  });

  it("swaps a row's song from the catalog and closes the editor", () => {
    const { onChange, rerender } = editor({
      sequence: {
        mode: "manual",
        activeItemId: "a",
        items: [
          preset("a", {
            songId: 3,
            durationMs: 1000,
            earoneSongId: "old",
            earoneRank: "9",
            earoneSpins: "1",
          }),
          preset("b", { audioUrl: "https://example.test/1.mp3" }),
          preset("c", {
            artist: "",
            title: "Beta tune",
            coverUrl: "",
            audioUrl: "",
          }),
          preset("d", { audioUrl: "" }),
        ],
      },
      songCatalog: catalog,
      view: "queue",
    });
    const swapOf = (index: number) => {
      fireEvent.click(within(rows()[index]).getByLabelText("Edit song"));
      return screen.getByLabelText("Swap song...") as HTMLSelectElement;
    };
    // Each row shows the catalog song it matches: by id, by audio, or by its text.
    expect(swapOf(0)).toHaveValue("3");
    fireEvent.click(within(rows()[0]).getByLabelText("Edit song"));
    expect(screen.queryByLabelText("Swap song...")).toBeNull();
    expect(swapOf(1)).toHaveValue("1");
    expect(swapOf(2)).toHaveValue("2");
    const swap = swapOf(3);
    expect(swap).toHaveValue("");
    expect(
      within(swap)
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual(["Swap song...", "Song #6", "Alpha", "Beta tune", "Zeta - Last"]);
    fireEvent.change(swap, { target: { value: "2" } });
    expect(onChange.mock.lastCall![0].items[3]).toMatchObject({
      id: "d",
      songId: 2,
      artist: "Artist d",
      title: "Beta tune",
      coverUrl: "",
      audioUrl: "https://example.test/2.mp3",
    });
    expect(screen.queryByLabelText("Swap song...")).toBeNull();
    fireEvent.change(swapOf(0), { target: { value: "1" } });
    expect(onChange.mock.lastCall![0].items[0]).toMatchObject({
      songId: 1,
      artist: "Alpha",
      title: "Title a",
      durationMs: 1000,
      earoneSongId: "old",
      earoneRank: "9",
      earoneSpins: "1",
    });
    fireEvent.change(swapOf(0), { target: { value: "3" } });
    expect(onChange.mock.lastCall![0].items[0]).toMatchObject({
      songId: 3,
      durationMs: 200_400,
      earoneSongId: "e3",
    });

    // An open editor closes when its row leaves the playlist.
    swapOf(1);
    rerender(
      <ProgramSongSequenceEditor
        undoScope="test-program"
        sequence={
          { mode: "manual", activeItemId: "a", items: [preset("a")] } as any
        }
        songCatalog={catalog as any}
        view="queue"
        onChange={onChange}
      />,
    );
    expect(screen.queryByLabelText("Swap song...")).toBeNull();
  });
});

describe("ProgramSongSequenceEditor remove edge cases (gaulatti/alcantara#186)", () => {
  it("leaves no active song when the last remaining row is removed", () => {
    vi.spyOn(Date, "now").mockReturnValue(5_000);
    const { onChange } = editor({
      sequence: {
        mode: "manual",
        activeItemId: "only",
        items: [preset("only")],
      },
      view: "queue",
    });
    fireEvent.click(within(rows()[0]).getByLabelText("Remove"));
    expect(onChange.mock.lastCall![0]).toEqual(
      expect.objectContaining({ items: [], activeItemId: null }),
    );
  });

  it("keeps the autoplay clock on the playing song when a row before it is removed", () => {
    vi.spyOn(Date, "now").mockReturnValue(9_000);
    const { onChange } = editor({
      sequence: {
        mode: "shuffle",
        loop: true,
        activeItemId: "ghost",
        items: [preset("a"), preset("b")],
      },
      programSongPlayback: {
        audioUrl: "https://example.test/a.mp3",
        token: "a:1",
        currentTimeMs: 1_000,
        isPlaying: false,
      },
      view: "queue",
    });
    fireEvent.click(within(rows()[1]).getByLabelText("Remove"));
    expect(onChange.mock.lastCall![0]).toEqual(
      expect.objectContaining({
        items: [expect.objectContaining({ id: "a" })],
        activeItemId: "a",
        startedAt: 8_000,
      }),
    );
  });
});

// gaulatti/alcantara#527 (untriaged gaps): an automatic playlist whose active id names no row still keeps the
// clock when another row is removed.
it("keeps an automatic playlist's clock when its active id names no row and another row is removed", () => {
  const { onChange } = editor({
    sequence: { mode: "autoplay", activeItemId: "ghost", items: [preset("a"), preset("b")] },
    programSongPlayback: { isPlaying: true, token: "b:1", audioUrl: "" },
    view: "queue",
  });
  fireEvent.click(within(rows()[0]).getByLabelText("Remove"));
  expect(onChange.mock.lastCall![0]).toMatchObject({
    mode: "autoplay",
    items: [expect.objectContaining({ id: "b" })],
  });
  expect(typeof onChange.mock.lastCall![0].startedAt).toBe("number");
});

describe("ProgramSongSequenceEditor remove undo", () => {
  const seq = () => ({
    mode: "manual",
    activeItemId: "a",
    items: [preset("a"), preset("b"), preset("c")],
  });
  const ids = (sequence: any) => sequence.items.map((item: any) => item.id);

  beforeEach(() => {
    vi.useFakeTimers();
    window.sessionStorage.clear();
  });
  afterEach(() => {
    vi.useRealTimers();
    window.sessionStorage.clear();
  });

  const removeRow = (index: number) =>
    fireEvent.click(within(rows()[index]).getByRole("button", { name: "Remove" }));

  it("removes at once, then Undo puts the song back in its place", () => {
    const view = editor({ sequence: seq(), view: "queue" });
    removeRow(1);
    expect(ids(view.onChange.mock.lastCall![0])).toEqual(["a", "c"]);
    view.rerender(
      <ProgramSongSequenceEditor
        undoScope="test-program"
        onChange={view.onChange}
        sequence={view.onChange.mock.lastCall![0]}
        view="queue"
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "Removed Title b from playlist.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(ids(view.onChange.mock.lastCall![0])).toEqual(["a", "b", "c"]);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("stops offering Undo after 8 seconds", () => {
    editor({ sequence: seq(), view: "queue" });
    removeRow(1);
    expect(screen.getByRole("status")).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(7_999);
    });
    expect(screen.getByRole("status")).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("still offers Undo after a reload inside the window, and restores the same place", () => {
    const first = editor({ sequence: seq(), view: "queue" });
    removeRow(1);
    const saved = first.onChange.mock.lastCall![0];
    first.unmount();
    // The page reloads: a new editor reads the pending undo from sessionStorage.
    const second = editor({ sequence: saved, view: "queue" });
    expect(screen.getByRole("status")).toHaveTextContent("Removed Title b");
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(ids(second.onChange.mock.lastCall![0])).toEqual(["a", "b", "c"]);
  });

  it("offers nothing after a reload once the window has passed", () => {
    const first = editor({ sequence: seq(), view: "queue" });
    removeRow(1);
    const saved = first.onChange.mock.lastCall![0];
    first.unmount();
    act(() => {
      vi.advanceTimersByTime(8_000);
    });
    editor({ sequence: saved, view: "queue" });
    expect(screen.queryByRole("status")).toBeNull();
  });
});

describe("ProgramSongSequenceEditor undo per program", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    window.sessionStorage.clear();
  });
  afterEach(() => {
    vi.useRealTimers();
    window.sessionStorage.clear();
  });

  it("never applies program A's Undo to program B when the editor switches within the window", () => {
    const aSeq = { mode: "manual", activeItemId: "a", items: [preset("a"), preset("b"), preset("c")] };
    const bSeq = { mode: "manual", activeItemId: "x", items: [preset("x"), preset("y")] };
    const view = editor({ sequence: aSeq, view: "queue", undoScope: "program-a" });
    fireEvent.click(within(rows()[1]).getByRole("button", { name: "Remove" }));
    const aSaved = view.onChange.mock.lastCall![0];
    expect(aSaved.items.map((i: any) => i.id)).toEqual(["a", "c"]);

    // The same editor now shows program B, with the same rotation label.
    view.rerender(
      <ProgramSongSequenceEditor
        undoScope="program-b"
        onChange={view.onChange}
        sequence={bSeq as any}
        view="queue"
      />,
    );
    expect(screen.queryByRole("status")).toBeNull();
    expect(window.sessionStorage.getItem("alcantara.rotationUndo.program-b.Playlist")).toBeNull();

    // Back in program A within the window, its own Undo is offered again and restores b there.
    view.rerender(
      <ProgramSongSequenceEditor
        undoScope="program-a"
        onChange={view.onChange}
        sequence={aSaved}
        view="queue"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(view.onChange.mock.lastCall![0].items.map((i: any) => i.id)).toEqual(["a", "b", "c"]);
  });
});
