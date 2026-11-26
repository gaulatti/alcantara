import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router";
import ScheduledRundown from "./ScheduledRundown";
import type {
  FlightCue,
  FlightSequence,
  InstantItem,
  SongCatalogItem,
} from "../models/broadcast";
import {
  createFlightSequence,
  fetchFlightSequences,
  preflightFlightSequence,
  publishFlightSequence,
  updateFlightSequence,
} from "../services/flight";

// The direct-manipulation builder (gaulatti/alcantara#299) over the live
// rundown, with the same stand-ins as ScheduledRundown.live.test.tsx.

vi.mock("../utils/globalProgram", () => ({
  useGlobalProgramId: () => ["radio-demo"],
}));
vi.mock("../services/flight", () => ({
  createFlightSequence: vi.fn(),
  fetchFlightSequences: vi.fn(),
  preflightFlightSequence: vi.fn(),
  publishFlightSequence: vi.fn(),
  updateFlightSequence: vi.fn(),
  fillRundown: vi.fn(),
}));
vi.mock("../services/mediaLabels", () => ({
  fetchAllMediaLabels: vi.fn().mockResolvedValue([]),
}));
vi.mock("./RadioLogGenerator", () => ({
  RadioLogGenerator: ({
    log,
    onGenerated,
  }: {
    log: FlightSequence | null;
    onGenerated: (items: FlightCue[]) => void;
  }) => (
    <button
      type="button"
      onClick={() =>
        onGenerated([{ id: "built", kind: "stopSong", clockOffsetSeconds: 0 }])
      }
    >
      Generate for {log?.name ?? "nothing"}
    </button>
  ),
}));
vi.mock("./VoiceTrackRecorder", () => ({
  VoiceTrackRecorder: ({
    songTitle,
    onAttach,
    onClose,
  }: {
    songTitle: string;
    onAttach: (
      instantId: number,
      mix: { duckGain: number; fadeInSeconds: number; fadeOutSeconds: number },
    ) => Promise<void>;
    onClose: () => void;
  }) => (
    <div>
      <p>Recording over {songTitle}</p>
      <button
        type="button"
        onClick={() =>
          void onAttach(42, {
            duckGain: 0.5,
            fadeInSeconds: 1,
            fadeOutSeconds: 2,
          })
        }
      >
        Attach take
      </button>
      <button type="button" onClick={onClose}>
        Close recorder
      </button>
    </div>
  ),
}));
vi.mock("@gaulatti/bleecker", async (original) => {
  const actual = await original<typeof import("@gaulatti/bleecker")>();
  return {
    ...actual,
    Select: ({
      options,
      onChange,
      value,
      ...props
    }: {
      options: { value: string; label: string }[];
      onChange: (value: string) => void;
      value: string;
    }) => (
      <select
        {...props}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    ),
  };
});

const song = (id: number, title: string, enabled = true): SongCatalogItem => ({
  id,
  title,
  artist: "The Lighthouse Keepers",
  durationMs: 60_000,
  audioUrl: `https://media.example/${id}.mp3`,
  coverUrl: null,
  earoneSongId: null,
  earoneRank: null,
  earoneSpins: null,
  enabled,
});

const clip = (id: number, name: string, enabled = true): InstantItem => ({
  id,
  name,
  audioUrl: `https://media.example/clip-${id}.mp3`,
  volume: 1,
  enabled,
  position: id,
});

const block = (overrides: Partial<FlightSequence> = {}): FlightSequence => ({
  id: 7,
  name: "Morning news",
  revision: 3,
  items: [
    { id: "open", kind: "playSong", songId: 2, clockOffsetSeconds: 0 },
    { id: "ident", kind: "instant", instantId: 9, durationMs: 30_000 },
  ],
  scheduledAt: "2026-11-17T10:00:00",
  publishedAt: null,
  lastStartedAt: null,
  isRunning: false,
  activeItemId: null,
  loop: false,
  createdAt: "",
  updatedAt: "",
  ...overrides,
});

interface Library {
  songsOk?: boolean;
  clipsOk?: boolean;
  audioOk?: boolean;
  secondPageOk?: boolean;
  songData?: unknown;
  clipPayload?: unknown;
  audio?: unknown;
  paged?: boolean;
}

function stubLibrary({
  songsOk = true,
  clipsOk = true,
  audioOk = true,
  secondPageOk = true,
  songData = [song(1, "Disabled jingle", false), song(2, "Harbor Light")],
  clipPayload = [clip(8, "Old ident", false), clip(9, "Station ident")],
  audio = { songSequence: { items: [{}, {}, {}] } },
  paged = true,
}: Library = {}) {
  const fetchMock = vi.fn(async (url: string) => {
    if (url.includes("/songs?page=2"))
      return secondPageOk
        ? Response.json({ data: [song(3, "Low Tide")] })
        : new Response(null, { status: 500 });
    if (url.includes("/songs"))
      return songsOk
        ? Response.json(
            paged
              ? { data: songData, meta: { totalPages: 2 } }
              : { data: songData },
          )
        : new Response(null, { status: 500 });
    if (url.includes("/instants"))
      return clipsOk
        ? Response.json(clipPayload)
        : new Response(null, { status: 500 });
    if (url.includes("/audio-bus"))
      return audioOk
        ? Response.json(audio)
        : new Response(null, { status: 503 });
    throw new Error(`unexpected ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderRundown(onDirtyChange?: (dirty: boolean) => void) {
  return render(
    <MemoryRouter>
      <ScheduledRundown onDirtyChange={onDirtyChange} />
    </MemoryRouter>,
  );
}

async function openBlock() {
  return screen.findByRole("table", { name: "Scheduled rundown events" });
}

const eventRows = (table: HTMLElement) => within(table).getAllByRole("button");
// The library replaces the Song, Clip and Stop buttons (#299): select a row and
// press Enter to add it at the end.
const library = () => screen.getByRole("listbox", { name: "Library items" });
const addFromLibrary = (name: RegExp) => {
  fireEvent.click(within(library()).getByRole("option", { name }));
  fireEvent.keyDown(library(), { key: "Enter" });
};

beforeEach(() => {
  // jsdom has no modal dialog; open and close it as a browser would.
  HTMLDialogElement.prototype.showModal = function showModal() {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function close() {
    this.open = false;
  };
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
  vi.mocked(fetchFlightSequences).mockResolvedValue([
    block({ id: 3, name: "Unscheduled", scheduledAt: null }),
    block(),
  ]);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

// jsdom has neither DragEvent nor PointerEvent, so testing-library would
// fire plain Events without a pointer position; give it mouse-event shapes.
beforeEach(() => {
  class PositionedEvent extends MouseEvent {
    pointerId: number;
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 0;
    }
  }
  vi.stubGlobal("DragEvent", PositionedEvent);
  vi.stubGlobal("PointerEvent", PositionedEvent);
});

// jsdom lays nothing out: give the ruler and the lane a 900 px width, so 15
// minutes is 60 px a minute.
function layOut() {
  for (const name of ["Rundown timeline"]) {
    const timeline = screen.getByRole("region", { name });
    for (const element of [
      timeline.querySelector(".rundown-ruler"),
      timeline.querySelector(".rundown-lane"),
    ])
      vi.spyOn(element as HTMLElement, "getBoundingClientRect").mockReturnValue(
        { left: 0, width: 900, top: 0, height: 30 } as DOMRect,
      );
  }
}

function dataTransfer() {
  const data: Record<string, string> = {};
  return {
    data,
    types: [] as string[],
    effectAllowed: "",
    dropEffect: "",
    setData(type: string, value: string) {
      data[type] = value;
      this.types.push(type);
    },
    getData: (type: string) => data[type] ?? "",
  };
}

const fixedStartInput = () =>
  screen.getByRole("spinbutton", { name: "Fixed start" });

it("drops a library item where it lands on the timeline, and nowhere when the drag is foreign", async () => {
  stubLibrary();
  renderRundown();
  const table = await openBlock();
  layOut();
  const lane = screen.getByRole("group", { name: "Timeline items" });
  const transfer = dataTransfer();
  fireEvent.dragStart(
    within(library()).getByRole("option", { name: /^Station ident/ }),
    { dataTransfer: transfer },
  );
  fireEvent.dragOver(lane, { dataTransfer: transfer });
  expect(lane).toHaveAttribute("data-dropping", "true");
  // At 00:01, ahead of the opening song: it becomes the block's opener.
  fireEvent.drop(lane, { dataTransfer: transfer, clientX: 1 });
  expect(lane).toHaveAttribute("data-dropping", "false");
  let rows = eventRows(table);
  expect(rows).toHaveLength(3);
  expect(rows[0]).toHaveTextContent("Station ident");
  expect(rows[1]).toHaveTextContent("Harbor Light");
  expect(fixedStartInput()).toHaveValue(0);
  fireEvent.click(rows[1]);
  expect(fixedStartInput()).toHaveValue(null);

  // A drag that is not a library entry adds nothing.
  const foreign = dataTransfer();
  foreign.setData("text/plain", "Harbor Light");
  fireEvent.dragOver(lane, { dataTransfer: foreign });
  fireEvent.drop(lane, { dataTransfer: foreign, clientX: 800 });
  expect(eventRows(table)).toHaveLength(3);
  const malformed = dataTransfer();
  malformed.setData("application/x-alcantara-rundown-entry", "{not json");
  fireEvent.drop(lane, { dataTransfer: malformed, clientX: 800 });
  fireEvent.dragLeave(lane);
  rows = eventRows(table);
  expect(rows).toHaveLength(3);
  expect(rows.at(-1)).toHaveTextContent("Station ident");
});

it("adds the searched item with Enter and moves the selection with the arrows", async () => {
  stubLibrary();
  renderRundown();
  const table = await openBlock();
  const search = screen.getByRole("searchbox", { name: "Search the library" });
  fireEvent.keyDown(window, { key: "/" });
  expect(search).toHaveFocus();
  fireEvent.change(search, { target: { value: "zzz" } });
  expect(within(library()).getByText(/Nothing matches/)).toBeVisible();
  fireEvent.keyDown(search, { key: "Enter" });
  expect(eventRows(table)).toHaveLength(2);
  fireEvent.change(search, { target: { value: "" } });
  fireEvent.click(screen.getByRole("button", { name: "Clips" }));
  // Disabled clips are not offered; the stop is not a clip.
  expect(within(library()).getAllByRole("option")).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "All" }));
  fireEvent.keyDown(search, { key: "ArrowDown" });
  fireEvent.keyDown(search, { key: "ArrowDown" });
  fireEvent.keyDown(search, { key: "ArrowDown" });
  fireEvent.keyDown(search, { key: "ArrowUp" });
  expect(
    within(library()).getByRole("option", { selected: true }),
  ).toHaveTextContent("Station ident");
  fireEvent.keyDown(search, { key: "Enter" });
  expect(eventRows(table).at(-1)).toHaveTextContent("Station ident");
  fireEvent.doubleClick(
    within(library()).getByRole("option", { name: /^Stop program audio/ }),
  );
  expect(eventRows(table).at(-1)).toHaveTextContent("Stop program audio");
  // ⌘/ is not the search shortcut, and typing / in a field is just a slash.
  search.blur();
  fireEvent.keyDown(window, { key: "/", metaKey: true });
  expect(search).not.toHaveFocus();
  const duration = screen.getByRole("spinbutton", { name: "Fixed start" });
  duration.focus();
  fireEvent.keyDown(duration, { key: "/" });
  expect(duration).toHaveFocus();
});

it("moves a fixed start with the arrow keys and by dragging its pin, in 5 s steps", async () => {
  stubLibrary();
  vi.mocked(fetchFlightSequences).mockResolvedValue([
    block({
      items: [
        { id: "open", kind: "playSong", songId: 2, clockOffsetSeconds: 0 },
        { id: "ident", kind: "instant", instantId: 9, durationMs: 30_000 },
        {
          id: "news",
          kind: "instant",
          instantId: 9,
          durationMs: 60_000,
          clockOffsetSeconds: 300,
        },
      ],
    }),
  ]);
  renderRundown();
  const table = await openBlock();
  layOut();
  const [opener, news] = screen.getAllByRole("slider");
  expect(opener).toHaveAttribute("aria-disabled", "true");
  fireEvent.keyDown(opener, { key: "ArrowRight" });
  fireEvent.pointerDown(opener, { pointerId: 1 });
  expect(news).toHaveAttribute("aria-valuenow", "300");
  fireEvent.keyDown(news, { key: "ArrowRight" });
  expect(news).toHaveAttribute("aria-valuenow", "305");
  fireEvent.keyDown(news, { key: "ArrowRight", shiftKey: true });
  expect(news).toHaveAttribute("aria-valuenow", "365");
  fireEvent.keyDown(news, { key: "ArrowLeft" });
  fireEvent.keyDown(news, { key: "Tab" });
  expect(news).toHaveAttribute("aria-valuenow", "360");
  fireEvent.click(eventRows(table)[2]);
  expect(fixedStartInput()).toHaveValue(360);

  // Dragged to 480 px of 900 (08:00), snapped to 5 s.
  fireEvent.pointerMove(news, { clientX: 480 });
  expect(news).toHaveAttribute("aria-valuenow", "360");
  fireEvent.pointerDown(news, { pointerId: 1 });
  expect(news).toHaveAttribute("data-dragging", "true");
  fireEvent.pointerMove(news, { clientX: 482 });
  expect(news).toHaveAttribute("aria-valuenow", "480");
  fireEvent.pointerUp(news);
  expect(news).toHaveAttribute("data-dragging", "false");
  expect(fixedStartInput()).toHaveValue(480);
  fireEvent.pointerDown(news, { pointerId: 1 });
  fireEvent.pointerMove(news, { clientX: -50 });
  fireEvent.pointerCancel(news);
  expect(fixedStartInput()).toHaveValue(0);
  expect(screen.getByText(/Unsaved changes/)).toBeVisible();
});

it("draws gaps, cuts and unknown lengths from rundownTiming(), and pins or frees a start", async () => {
  stubLibrary();
  vi.mocked(fetchFlightSequences).mockResolvedValue([
    block({
      items: [
        { id: "open", kind: "playSong", songId: 2, clockOffsetSeconds: 0 },
        { id: "ident", kind: "instant", instantId: 9, durationMs: 30_000 },
        {
          id: "news",
          kind: "instant",
          instantId: 9,
          durationMs: 60_000,
          clockOffsetSeconds: 300,
        },
        { id: "nolength", kind: "instant", instantId: 9 },
        { id: "end", kind: "stopSong", clockOffsetSeconds: 360 },
      ],
    }),
  ]);
  renderRundown();
  const table = await openBlock();
  const timeline = screen.getByRole("region", { name: "Rundown timeline" });
  // 01:00 + 00:30 runs to 01:30; the news at 05:00 leaves a 03:30 gap.
  expect(within(timeline).getByRole("status")).toHaveTextContent(
    "Content 02:30 · Gaps 03:30 · 1 with no stored length",
  );
  expect(within(timeline).getByTitle(/03:30 gap/)).toHaveTextContent(
    "Gap 03:30",
  );
  expect(
    within(timeline).getByRole("button", { name: /no stored length$/ }),
  ).toHaveAttribute("data-unknown", "true");

  // Pinning the ident at its estimated start (01:00) leaves the timing alone.
  fireEvent.click(eventRows(table)[1]);
  fireEvent.click(screen.getByRole("button", { name: "Pin its start here" }));
  expect(fixedStartInput()).toHaveValue(60);
  expect(screen.getAllByRole("slider")).toHaveLength(4);
  fireEvent.click(
    screen.getByRole("button", { name: "Follow the previous event" }),
  );
  expect(fixedStartInput()).toHaveValue(null);
  expect(screen.getAllByRole("slider")).toHaveLength(3);
  // The timeline selects the same event as the log.
  fireEvent.click(
    within(timeline).getByRole("button", { name: /^Harbor Light, starts/ }),
  );
  expect(screen.getByText(/Event 01/)).toBeVisible();
});

const overrunning = () =>
  block({
    items: [
      { id: "open", kind: "playSong", songId: 2, clockOffsetSeconds: 0 },
      { id: "ident", kind: "instant", instantId: 9, durationMs: 30_000 },
      {
        id: "news",
        kind: "instant",
        instantId: 9,
        durationMs: 60_000,
        clockOffsetSeconds: 60,
      },
    ],
  });

it("warns before publishing a block whose content overruns a fixed start", async () => {
  stubLibrary();
  vi.mocked(fetchFlightSequences).mockResolvedValue([overrunning()]);
  vi.mocked(publishFlightSequence).mockImplementation(async (_program, id) =>
    block({ id, revision: 4, publishedAt: "2026-11-17T09:00:00Z" }),
  );
  renderRundown();
  await openBlock();
  const timeline = screen.getByRole("region", { name: "Rundown timeline" });
  expect(within(timeline).getByRole("status")).toHaveTextContent(
    "Overrun 00:30",
  );
  expect(within(timeline).getByTitle(/00:30 cut/)).toBeVisible();

  fireEvent.click(screen.getByRole("button", { name: "Publish" }));
  const dialog = await screen.findByRole("dialog");
  expect(within(dialog).getByRole("alert")).toHaveTextContent(
    "00:30 of content is cut at the next fixed start",
  );
  fireEvent.click(within(dialog).getByRole("button", { name: "Keep editing" }));
  expect(publishFlightSequence).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole("button", { name: "Publish" }));
  fireEvent.click(
    within(await screen.findByRole("dialog")).getByRole("button", {
      name: "Publish anyway",
    }),
  );
  expect(
    await screen.findByText("Rundown published for automatic start."),
  ).toBeVisible();
  expect(publishFlightSequence).toHaveBeenCalledWith("radio-demo", 7, 3);
  // Plain Publish does not gate on Check; it reads the published revision's check once, afterwards, so the desk
  // never assumes it ready (D1).
  expect(preflightFlightSequence).toHaveBeenCalledTimes(1);
  expect(preflightFlightSequence).toHaveBeenCalledWith("radio-demo", 7);
});

it("checks and publishes with ⌘↵ only when the check passes on the saved revision", async () => {
  stubLibrary();
  vi.mocked(updateFlightSequence).mockImplementation(
    async (_program, id, body) => block({ id, revision: 4, items: body.items }),
  );
  vi.mocked(preflightFlightSequence)
    .mockResolvedValueOnce({
      ready: false,
      issues: ["Station ident has no audio"],
      warnings: [],
    })
    .mockResolvedValueOnce({ ready: true, issues: [], warnings: [] });
  vi.mocked(publishFlightSequence).mockImplementation(async (_program, id) =>
    block({ id, revision: 5, publishedAt: "2026-11-17T09:00:00Z" }),
  );
  renderRundown();
  await openBlock();
  addFromLibrary(/^Stop program audio/);
  fireEvent.keyDown(window, { key: "Enter", metaKey: true });
  expect(await screen.findByText("Station ident has no audio")).toBeVisible();
  expect(updateFlightSequence).toHaveBeenCalledTimes(1);
  expect(preflightFlightSequence).toHaveBeenCalledWith("radio-demo", 7);
  expect(publishFlightSequence).not.toHaveBeenCalled();

  fireEvent.keyDown(window, { key: "Enter" });
  expect(preflightFlightSequence).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: /Check & publish/ }));
  expect(
    await screen.findByText("Rundown published for automatic start."),
  ).toBeVisible();
  // The saved revision is checked and published; nothing is saved twice.
  expect(updateFlightSequence).toHaveBeenCalledTimes(1);
  expect(publishFlightSequence).toHaveBeenCalledWith("radio-demo", 7, 4);
  expect(screen.getByText(/PUBLISHED · Revision 5/)).toBeVisible();
  // A published block that has aired can no longer be published.
  fireEvent.keyDown(window, { key: "Enter", ctrlKey: true });
  expect(publishFlightSequence).toHaveBeenCalledTimes(1);
});

it("checks and publishes an overrunning block only after the warning, and reports a failure", async () => {
  stubLibrary();
  vi.mocked(fetchFlightSequences).mockResolvedValue([overrunning()]);
  vi.mocked(preflightFlightSequence).mockRejectedValue(
    new Error("Palazzo unavailable"),
  );
  renderRundown();
  await openBlock();
  fireEvent.keyDown(window, { key: "Enter", ctrlKey: true });
  fireEvent.click(
    within(await screen.findByRole("dialog")).getByRole("button", {
      name: "Publish anyway",
    }),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Palazzo unavailable",
  );
  expect(publishFlightSequence).not.toHaveBeenCalled();
});

it("edits raw cue parameters behind Advanced and removes an emptied one", async () => {
  stubLibrary();
  renderRundown();
  const table = await openBlock();
  fireEvent.click(eventRows(table)[1]);
  fireEvent.click(screen.getByText("Advanced"));
  fireEvent.change(
    screen.getByRole("spinbutton", { name: "Music under voice (0–1)" }),
    { target: { value: "0.4" } },
  );
  fireEvent.change(screen.getByRole("textbox", { name: "Transition id" }), {
    target: { value: "wipe" },
  });
  fireEvent.click(screen.getByRole("checkbox"));
  const stored = screen.getByLabelText("Cue as stored");
  expect(JSON.parse(stored.textContent ?? "{}")).toEqual({
    id: "ident",
    kind: "instant",
    instantId: 9,
    durationMs: 30_000,
    voiceDuckGain: 0.4,
    transitionId: "wipe",
    isFiller: true,
  });
  fireEvent.change(
    screen.getByRole("spinbutton", { name: "Music under voice (0–1)" }),
    { target: { value: "" } },
  );
  fireEvent.change(screen.getByRole("textbox", { name: "Transition id" }), {
    target: { value: "" },
  });
  fireEvent.click(screen.getByRole("checkbox"));
  // Every parameter emptied again: the block is as stored, nothing to save.
  expect(screen.queryByText(/Unsaved changes/)).not.toBeInTheDocument();
  expect(JSON.parse(stored.textContent ?? "{}")).toEqual({
    id: "ident",
    kind: "instant",
    instantId: 9,
    durationMs: 30_000,
  });
});

it("saves a block built in the timeline in the same flight JSON shape the forms did", async () => {
  stubLibrary();
  vi.mocked(fetchFlightSequences).mockResolvedValue([block({ items: [] })]);
  vi.mocked(updateFlightSequence).mockImplementation(
    async (_program, id, body) => block({ id, revision: 4, items: body.items }),
  );
  renderRundown();
  await screen.findByText(/DRAFT · Revision 3 · 0 events/);
  addFromLibrary(/^Harbor Light/);
  addFromLibrary(/^Station ident/);
  fireEvent.change(screen.getByRole("spinbutton", { name: "Clip duration" }), {
    target: { value: "20" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Pin its start here" }));
  addFromLibrary(/^Stop program audio/);
  fireEvent.click(screen.getByRole("button", { name: /Save/ }));
  expect(await screen.findByText("Rundown saved.")).toBeVisible();
  const saved = vi.mocked(updateFlightSequence).mock.calls[0][2];
  // Exactly the keys the Song, Clip and Stop forms wrote: no new field.
  expect(JSON.parse(JSON.stringify(saved))).toEqual({
    revision: 3,
    items: [
      {
        id: expect.any(String),
        kind: "playSong",
        songId: 2,
        clockOffsetSeconds: 0,
      },
      {
        id: expect.any(String),
        kind: "instant",
        instantId: 9,
        durationMs: 20_000,
        clockOffsetSeconds: 60,
      },
      { id: expect.any(String), kind: "stopSong" },
    ],
  });
});

it("keeps an existing rundown byte for byte when its pins are moved and moved back", async () => {
  stubLibrary();
  const stored = overrunning();
  vi.mocked(fetchFlightSequences).mockResolvedValue([stored]);
  renderRundown();
  await openBlock();
  const news = screen.getAllByRole("slider")[1];
  fireEvent.keyDown(news, { key: "ArrowRight" });
  expect(screen.getByText(/Unsaved changes/)).toBeVisible();
  fireEvent.keyDown(news, { key: "ArrowLeft" });
  expect(screen.queryByText(/Unsaved changes/)).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: /Save/ })).toBeDisabled();
  expect(stored.items).toEqual(overrunning().items);
});

// gaulatti/alcantara#527 (stronger pass, line 760): an event after one with no stored length has no estimated start,
// so pinning it fixes its start at 00:00, the only start the timing can offer, which the operator then adjusts.
it("pins an event with no estimated start at 00:00", async () => {
  stubLibrary();
  vi.mocked(fetchFlightSequences).mockResolvedValue([
    block({
      items: [
        { id: "open", kind: "playSong", songId: 2, clockOffsetSeconds: 0 },
        { id: "nolength", kind: "instant", instantId: 9 },
        { id: "after", kind: "instant", instantId: 9, durationMs: 30_000 },
        { id: "end", kind: "stopSong", clockOffsetSeconds: 360 },
      ],
    }),
  ]);
  renderRundown();
  const table = await openBlock();
  fireEvent.click(eventRows(table)[2]);
  expect(fixedStartInput()).toHaveValue(null);
  fireEvent.click(screen.getByRole("button", { name: "Pin its start here" }));
  expect(fixedStartInput()).toHaveValue(0);
  expect(screen.getByText(/Unsaved changes/)).toBeVisible();
});
