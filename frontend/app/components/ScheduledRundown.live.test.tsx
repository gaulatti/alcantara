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

// The live rundown (no fixture data): it loads the program's blocks and radio
// library from the API and saves, checks and publishes through the flight
// service. RadioLogGenerator and VoiceTrackRecorder are covered by
// gaulatti/alcantara#184; here they are stand-ins that hand back their result.

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

it("loads the scheduled block, every page of the song catalog and the rotation size", async () => {
  const fetchMock = stubLibrary();
  renderRundown();
  const table = await openBlock();
  expect(fetchFlightSequences).toHaveBeenCalledWith("radio-demo");
  expect(
    fetchMock.mock.calls.some(([url]) => String(url).includes("/songs?page=2")),
  ).toBe(true);
  expect(
    await screen.findByText(/3 saved songs · runs independently/),
  ).toBeVisible();
  expect(eventRows(table)[0]).toHaveTextContent("Harbor Light");
  expect(eventRows(table)[1]).toHaveTextContent("Station ident");
  // Only scheduled blocks are offered, labelled with their state.
  const blocks = screen.getByRole("combobox", { name: "Scheduled block" });
  expect(within(blocks).getAllByRole("option")).toHaveLength(2);
  expect(within(blocks).getAllByRole("option")[1]).toHaveTextContent("Draft");
  expect(screen.getByText(/DRAFT · Revision 3 · 2 events/)).toBeVisible();
  expect(screen.getByText(/0 fillers · 00:00 unfilled/)).toBeVisible();
});

it("tolerates an empty rotation and library payloads that are not lists", async () => {
  stubLibrary({ songData: null, clipPayload: {}, audio: {} });
  renderRundown();
  const table = await openBlock();
  expect(
    await screen.findByText(/0 saved songs · runs independently/),
  ).toBeVisible();
  // Without the catalog the song is unknown and the clip cannot be resolved.
  expect(eventRows(table)[0]).toHaveTextContent("Choose song");
  expect(screen.getByText(/1 unknown durations/)).toBeVisible();
});

it.each([
  [{ songsOk: false }, "Radio library is unavailable"],
  [{ clipsOk: false }, "Radio library is unavailable"],
  [{ secondPageOk: false }, "Radio library is unavailable"],
  [{ audioOk: false }, "Continuous rotation is unavailable"],
])("explains a library that cannot be loaded (%j)", async (library, text) => {
  stubLibrary(library);
  renderRundown();
  expect(await screen.findByRole("alert")).toHaveTextContent(text);
});

it("explains a failure that is not an error object", async () => {
  stubLibrary();
  vi.mocked(fetchFlightSequences).mockRejectedValue("offline");
  renderRundown();
  expect(await screen.findByRole("alert")).toHaveTextContent("Request failed");
});

it("shows how to start when the program has no scheduled block", async () => {
  stubLibrary();
  vi.mocked(fetchFlightSequences).mockResolvedValue([]);
  renderRundown();
  expect(
    await screen.findByText("Timed content interrupts continuous fillers"),
  ).toBeVisible();
  expect(screen.getByRole("button", { name: /Song/ })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Check" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Publish" })).toBeDisabled();
});

it("creates a draft block only for a future start", async () => {
  stubLibrary();
  const created = block({ id: 11, name: "Evening", items: [] });
  vi.mocked(createFlightSequence).mockResolvedValue(created);
  renderRundown();
  await openBlock();
  fireEvent.click(screen.getByRole("button", { name: /New block/ }));
  const start = await screen.findByLabelText("New block");

  fireEvent.change(start, { target: { value: "2000-01-01T10:00" } });
  fireEvent.click(screen.getByRole("button", { name: "Create rundown" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Choose a future start time.",
  );
  expect(createFlightSequence).not.toHaveBeenCalled();

  vi.mocked(fetchFlightSequences).mockResolvedValue([block(), created]);
  fireEvent.change(start, { target: { value: "2099-01-01T10:00" } });
  fireEvent.click(screen.getByRole("button", { name: "Create rundown" }));
  await waitFor(() =>
    expect(createFlightSequence).toHaveBeenCalledWith(
      "radio-demo",
      expect.objectContaining({
        scheduledAt: new Date("2099-01-01T10:00").toISOString(),
        items: [],
      }),
    ),
  );
  expect(await screen.findByText("Draft rundown created.")).toBeVisible();
  expect(screen.getByRole("combobox", { name: "Scheduled block" })).toHaveValue(
    "11",
  );
  await waitFor(() =>
    expect(screen.queryByLabelText("New block")).not.toBeInTheDocument(),
  );
});

it("reports a block that could not be created", async () => {
  stubLibrary();
  vi.mocked(createFlightSequence).mockRejectedValue(new Error("Overlaps"));
  renderRundown();
  await openBlock();
  fireEvent.click(screen.getByRole("button", { name: /New block/ }));
  fireEvent.change(await screen.findByLabelText("New block"), {
    target: { value: "2099-01-01T10:00" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Create rundown" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Overlaps");
});

it("adds songs and clips before a fixed end, then saves and reports dirtiness", async () => {
  stubLibrary();
  vi.mocked(fetchFlightSequences).mockResolvedValue([
    block({
      items: [{ id: "end", kind: "stopSong", clockOffsetSeconds: 3600 }],
    }),
  ]);
  vi.mocked(updateFlightSequence).mockImplementation(
    async (_program, id, body) => block({ id, revision: 4, items: body.items }),
  );
  const onDirtyChange = vi.fn();
  const view = renderRundown(onDirtyChange);
  const table = await openBlock();

  fireEvent.click(screen.getByRole("button", { name: /Song/ }));
  fireEvent.click(screen.getByRole("button", { name: /Clip/ }));
  let rows = eventRows(table);
  expect(rows).toHaveLength(3);
  // The first enabled song and clip are chosen, ahead of the fixed end.
  expect(rows[0]).toHaveTextContent("Harbor Light");
  expect(rows[1]).toHaveTextContent("Station ident");
  expect(rows[2]).toHaveTextContent("Stop program audio");
  expect(screen.getByText(/Unsaved changes/)).toBeVisible();
  expect(onDirtyChange).toHaveBeenLastCalledWith(true);

  fireEvent.click(screen.getByRole("button", { name: /Save/ }));
  expect(await screen.findByText("Rundown saved.")).toBeVisible();
  expect(updateFlightSequence).toHaveBeenCalledWith("radio-demo", 7, {
    items: expect.arrayContaining([expect.objectContaining({ songId: 2 })]),
    revision: 3,
  });
  rows = eventRows(table);
  expect(rows).toHaveLength(3);
  expect(screen.queryByText(/Unsaved changes/)).not.toBeInTheDocument();
  expect(onDirtyChange).toHaveBeenLastCalledWith(false);
  view.unmount();
  expect(onDirtyChange).toHaveBeenLastCalledWith(false);
});

it("starts a new block's first event at its fixed start and appends after a following stop", async () => {
  stubLibrary();
  vi.mocked(fetchFlightSequences).mockResolvedValue([block({ items: [] })]);
  renderRundown();
  await screen.findByText(/DRAFT · Revision 3 · 0 events/);
  fireEvent.click(screen.getByRole("button", { name: /Stop/ }));
  // The first event is fixed at the block start.
  expect(screen.getByRole("spinbutton", { name: "Fixed start" })).toHaveValue(
    0,
  );
  expect(
    screen.getByRole("spinbutton", { name: "Fixed start" }),
  ).toBeDisabled();
  fireEvent.change(screen.getByRole("spinbutton", { name: "Fixed start" }), {
    target: { value: "" },
  });
  fireEvent.click(screen.getByRole("button", { name: /Song/ }));
  const table = screen.getByRole("table", { name: "Scheduled rundown events" });
  const rows = eventRows(table);
  expect(rows[0]).toHaveTextContent("Stop program audio");
  expect(rows[1]).toHaveTextContent("Harbor Light");
});

it("reports a save failure and keeps the edits", async () => {
  stubLibrary();
  vi.mocked(updateFlightSequence).mockRejectedValue(
    new Error("Stale revision"),
  );
  renderRundown();
  await openBlock();
  fireEvent.click(screen.getByRole("button", { name: /Stop/ }));
  fireEvent.click(screen.getByRole("button", { name: /Save/ }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Stale revision");
  expect(screen.getByText(/Unsaved changes/)).toBeVisible();
});

it("checks the saved block's audio and lists what needs attention", async () => {
  stubLibrary();
  vi.mocked(preflightFlightSequence)
    .mockResolvedValueOnce({ ready: true, issues: [] })
    .mockResolvedValueOnce({
      ready: false,
      issues: ["Station ident has no audio"],
    });
  renderRundown();
  await openBlock();
  fireEvent.click(screen.getByRole("button", { name: "Check" }));
  expect(
    await screen.findByText("Audio checked · ready for air"),
  ).toBeVisible();
  expect(screen.getByText("All scheduled audio is available.")).toBeVisible();
  expect(updateFlightSequence).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole("button", { name: "Check" }));
  expect(await screen.findByText("Needs attention")).toBeVisible();
  expect(screen.getByText("Station ident has no audio")).toBeVisible();
  expect(preflightFlightSequence).toHaveBeenLastCalledWith("radio-demo", 7);
});

it("saves unsaved edits before checking, and reports a failed check", async () => {
  stubLibrary();
  vi.mocked(updateFlightSequence).mockImplementation(
    async (_program, id, body) => block({ id, revision: 4, items: body.items }),
  );
  vi.mocked(preflightFlightSequence).mockRejectedValue(
    new Error("Palazzo unavailable"),
  );
  renderRundown();
  await openBlock();
  fireEvent.click(screen.getByRole("button", { name: /Stop/ }));
  fireEvent.click(screen.getByRole("button", { name: "Check" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Palazzo unavailable",
  );
  expect(updateFlightSequence).toHaveBeenCalledTimes(1);
});

it("publishes the block, saving unsaved edits first", async () => {
  stubLibrary();
  vi.mocked(updateFlightSequence).mockImplementation(
    async (_program, id, body) => block({ id, revision: 4, items: body.items }),
  );
  vi.mocked(publishFlightSequence).mockImplementation(async (_program, id) =>
    block({ id, revision: 5, publishedAt: "2026-11-17T09:00:00Z" }),
  );
  renderRundown();
  await openBlock();
  fireEvent.click(screen.getByRole("button", { name: /Stop/ }));
  fireEvent.click(screen.getByRole("button", { name: "Publish" }));
  expect(
    await screen.findByText("Rundown published for automatic start."),
  ).toBeVisible();
  expect(publishFlightSequence).toHaveBeenCalledWith("radio-demo", 7, 4);
  expect(screen.getByText(/PUBLISHED · Revision 5/)).toBeVisible();
});

it("keeps the ready-for-air confirmation after publishing moves the block to a new revision", async () => {
  stubLibrary();
  vi.mocked(updateFlightSequence).mockImplementation(
    async (_program, id, body) => block({ id, revision: 4, items: body.items }),
  );
  vi.mocked(publishFlightSequence).mockImplementation(async (_program, id) =>
    block({ id, revision: 5, publishedAt: "2026-11-17T09:00:00Z" }),
  );
  renderRundown();
  await openBlock();
  fireEvent.click(screen.getByRole("button", { name: /Stop/ }));
  fireEvent.click(screen.getByRole("button", { name: "Publish" }));
  expect(await screen.findByText(/PUBLISHED · Revision 5/)).toBeVisible();
  expect(screen.getByText("Audio checked · ready for air")).toBeVisible();
});

it("keeps a passing check after saving unsaved edits first, and drops it once the block changes", async () => {
  stubLibrary();
  vi.mocked(updateFlightSequence).mockImplementation(
    async (_program, id, body) => block({ id, revision: 4, items: body.items }),
  );
  vi.mocked(preflightFlightSequence).mockResolvedValue({
    ready: true,
    issues: [],
  });
  renderRundown();
  await openBlock();
  fireEvent.click(screen.getByRole("button", { name: /Stop/ }));
  fireEvent.click(screen.getByRole("button", { name: "Check" }));
  expect(
    await screen.findByText("Audio checked · ready for air"),
  ).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Stop" }));
  expect(screen.queryByText("Audio checked · ready for air")).toBeNull();
});

it("publishes a saved block directly and reports a refusal", async () => {
  stubLibrary();
  vi.mocked(publishFlightSequence).mockRejectedValue(new Error("Not ready"));
  renderRundown();
  await openBlock();
  fireEvent.click(screen.getByRole("button", { name: "Publish" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Not ready");
  expect(publishFlightSequence).toHaveBeenCalledWith("radio-demo", 7, 3);
  expect(updateFlightSequence).not.toHaveBeenCalled();
});

it("locks what has aired and marks the on-air event", async () => {
  stubLibrary();
  vi.mocked(fetchFlightSequences).mockResolvedValue([
    block({ id: 7, isRunning: true, activeItemId: "ident" }),
    block({
      id: 8,
      scheduledAt: "2026-11-17T11:00:00",
      lastStartedAt: "2026-11-17T11:00:00Z",
    }),
    block({
      id: 9,
      scheduledAt: "2026-11-17T12:00:00",
      publishedAt: "2026-11-17T08:00:00Z",
    }),
  ]);
  renderRundown();
  const table = await openBlock();
  const blocks = screen.getByRole("combobox", { name: "Scheduled block" });
  const labels = within(blocks)
    .getAllByRole("option")
    .map((option) => option.textContent);
  expect(labels[1]).toMatch(/On air$/);
  expect(labels[2]).toMatch(/Aired$/);
  expect(labels[3]).toMatch(/Published$/);
  expect(screen.getByText(/ON AIR · Revision 3/)).toBeVisible();
  expect(within(table).getAllByRole("row")[2]).toHaveAttribute(
    "data-active",
    "true",
  );
  // A running block still accepts new events, but its played events are locked.
  expect(screen.getByRole("button", { name: /Song/ })).toBeEnabled();
  expect(screen.getByRole("button", { name: "Publish" })).toBeDisabled();
  fireEvent.click(eventRows(table)[0]);
  expect(screen.getByText(/Event 01 · Locked/)).toBeVisible();
  expect(screen.getByRole("button", { name: /Remove/ })).toBeDisabled();

  fireEvent.change(blocks, { target: { value: "8" } });
  expect(await screen.findByText(/AIRED \/ INTERRUPTED/)).toBeVisible();
  expect(screen.getByRole("button", { name: /Song/ })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Publish" })).toBeDisabled();
  fireEvent.click(eventRows(table)[1]);
  expect(screen.getByText(/Event 02 · Locked/)).toBeVisible();

  fireEvent.change(blocks, { target: { value: "9" } });
  expect(await screen.findByText(/PUBLISHED · Revision 3/)).toBeVisible();
});

it("edits a clip's source, duration and fixed start in the inspector", async () => {
  stubLibrary();
  renderRundown();
  const table = await openBlock();
  fireEvent.click(eventRows(table)[1]);
  expect(screen.getByRole("heading", { name: "Audio clip" })).toBeVisible();
  expect(
    screen.getByText(/Follows the previous event\. The start in the log/),
  ).toBeVisible();

  fireEvent.change(screen.getByRole("combobox", { name: "Event clip" }), {
    target: { value: "8" },
  });
  expect(eventRows(table)[1]).toHaveTextContent("Old ident");
  fireEvent.change(screen.getByRole("combobox", { name: "Event clip" }), {
    target: { value: "" },
  });
  expect(eventRows(table)[1]).toHaveTextContent("Choose clip");

  fireEvent.change(screen.getByRole("spinbutton", { name: "Clip duration" }), {
    target: { value: "" },
  });
  expect(within(table).getAllByRole("row")[2]).toHaveTextContent("Unknown");
  fireEvent.change(screen.getByRole("spinbutton", { name: "Clip duration" }), {
    target: { value: "45" },
  });
  expect(within(table).getAllByRole("row")[2]).toHaveTextContent("00:45");

  fireEvent.change(screen.getByRole("spinbutton", { name: "Fixed start" }), {
    target: { value: "125" },
  });
  expect(
    screen.getByText("+02:05 · Starts on time and cuts the preceding filler."),
  ).toBeVisible();

  fireEvent.click(screen.getByRole("button", { name: "Discard" }));
  expect(eventRows(table)[1]).toHaveTextContent("Station ident");
  expect(screen.queryByText(/Unsaved changes/)).not.toBeInTheDocument();
});

it("changes an event's song, marks disabled songs and removes events", async () => {
  stubLibrary();
  renderRundown();
  const table = await openBlock();
  fireEvent.click(eventRows(table)[0]);
  const songSelect = screen.getByRole("combobox", { name: "Event song" });
  expect(
    within(songSelect).getByRole("option", {
      name: "The Lighthouse Keepers — Disabled jingle (disabled)",
    }),
  ).toBeInTheDocument();
  fireEvent.change(songSelect, { target: { value: "3" } });
  expect(eventRows(table)[0]).toHaveTextContent("Low Tide");
  fireEvent.change(songSelect, { target: { value: "" } });
  expect(eventRows(table)[0]).toHaveTextContent("Choose song");
  // A song that is not in the catalog cannot take a voice track.
  expect(
    screen.queryByRole("button", { name: /Record voice/ }),
  ).not.toBeInTheDocument();

  // Removing the first event makes the next one the fixed block start.
  fireEvent.click(screen.getByRole("button", { name: /Remove/ }));
  expect(eventRows(table)).toHaveLength(1);
  expect(
    screen.getByRole("heading", { name: "Select an event" }),
  ).toBeVisible();
  fireEvent.click(eventRows(table)[0]);
  expect(screen.getByRole("spinbutton", { name: "Fixed start" })).toHaveValue(
    0,
  );
});

it("brings the inspector into view on a narrow screen", async () => {
  stubLibrary();
  vi.stubGlobal("matchMedia", () => ({ matches: true }));
  const scrollIntoView = vi.fn();
  Element.prototype.scrollIntoView = scrollIntoView;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  renderRundown();
  const table = await openBlock();
  fireEvent.click(eventRows(table)[0]);
  expect(scrollIntoView).toHaveBeenCalledWith({ block: "start" });
});

it("records a voice track over a song and saves the block with it", async () => {
  stubLibrary();
  vi.mocked(fetchFlightSequences).mockResolvedValue([
    block({
      items: [
        {
          id: "open",
          kind: "playSong",
          songId: 2,
          clockOffsetSeconds: 0,
          voiceTrackInstantId: 12,
        },
        { id: "after", kind: "stopSong" },
      ],
    }),
  ]);
  vi.mocked(updateFlightSequence).mockImplementation(
    async (_program, id, body) => block({ id, revision: 4, items: body.items }),
  );
  renderRundown();
  const table = await openBlock();
  fireEvent.click(eventRows(table)[0]);
  expect(screen.getByText("Voice track #12 · music at 35%")).toBeVisible();

  fireEvent.click(screen.getByRole("button", { name: /Record voice/ }));
  expect(await screen.findByText("Recording over Harbor Light")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Close recorder" }));
  await waitFor(() =>
    expect(
      screen.queryByText("Recording over Harbor Light"),
    ).not.toBeInTheDocument(),
  );

  fireEvent.click(screen.getByRole("button", { name: /Record voice/ }));
  fireEvent.click(await screen.findByRole("button", { name: "Attach take" }));
  await waitFor(() =>
    expect(updateFlightSequence).toHaveBeenCalledWith("radio-demo", 7, {
      items: [
        expect.objectContaining({
          id: "open",
          voiceTrackInstantId: 42,
          voiceDuckGain: 0.5,
          voiceFadeInSeconds: 1,
          voiceFadeOutSeconds: 2,
        }),
        { id: "after", kind: "stopSong" },
      ],
      revision: 3,
    }),
  );
  await waitFor(() => expect(fetchFlightSequences).toHaveBeenCalledTimes(2));
});

it("applies filler previews and built blocks from the inspector tools", async () => {
  stubLibrary();
  renderRundown();
  const table = await openBlock();
  fireEvent.click(eventRows(table)[0]);

  fireEvent.click(screen.getByRole("button", { name: "Fill gaps" }));
  expect(
    await screen.findByRole("region", { name: "Rundown fillers" }),
  ).toBeVisible();
  expect(screen.getByRole("button", { name: "Fillers" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  fireEvent.click(screen.getByRole("button", { name: "Build block" }));
  fireEvent.click(
    screen.getByRole("button", { name: "Generate for Morning news" }),
  );
  expect(eventRows(table)).toHaveLength(1);
  expect(eventRows(table)[0]).toHaveTextContent("Stop program audio");
  expect(screen.getByText(/Unsaved changes/)).toBeVisible();

  fireEvent.click(screen.getByRole("button", { name: "Event" }));
  expect(
    screen.getByRole("heading", { name: "Select an event" }),
  ).toBeVisible();
});

it("replaces the events with an accepted filler preview", async () => {
  stubLibrary();
  const { fillRundown } = await import("../services/flight");
  const { fetchAllMediaLabels } = await import("../services/mediaLabels");
  vi.mocked(fetchAllMediaLabels).mockResolvedValue([
    { id: "music", name: "Music" },
  ]);
  vi.mocked(fillRundown).mockResolvedValue({
    items: [
      { id: "open", kind: "playSong", songId: 2, clockOffsetSeconds: 0 },
      { id: "fill", kind: "playSong", songId: 3, isFiller: true },
    ],
    warnings: [],
  });
  renderRundown();
  const table = await openBlock();
  fireEvent.click(screen.getByRole("button", { name: "Fillers" }));
  fireEvent.change(
    await screen.findByRole("combobox", { name: "Filler tag" }),
    { target: { value: "music" } },
  );
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Preview fillers" }));
  });
  await waitFor(() => expect(eventRows(table)).toHaveLength(2));
  expect(eventRows(table)[1]).toHaveTextContent("Low Tide");
  expect(screen.getByText(/1 fillers · /)).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Event" }));
  fireEvent.click(eventRows(table)[1]);
  expect(screen.getByText(/Event 02 · Filler/)).toBeVisible();
});

it("reads a single-page catalog without paging metadata", async () => {
  const fetchMock = stubLibrary({ paged: false });
  renderRundown();
  const table = await openBlock();
  expect(eventRows(table)[0]).toHaveTextContent("Harbor Light");
  expect(
    fetchMock.mock.calls.some(([url]) => String(url).includes("/songs?page=2")),
  ).toBe(false);
});

it("opens fixture data without a block", async () => {
  render(
    <MemoryRouter>
      <ScheduledRundown fixtureData={{ logs: [], songs: [], clips: [] }} />
    </MemoryRouter>,
  );
  expect(
    await screen.findByText("Timed content interrupts continuous fillers"),
  ).toBeVisible();
  expect(fetchFlightSequences).not.toHaveBeenCalled();
});

it("gives the fillers and build tools the fixture's own tag without loading any", async () => {
  const { fetchAllMediaLabels } = await import("../services/mediaLabels");
  render(
    <MemoryRouter>
      <ScheduledRundown
        fixtureData={{
          logs: [block()],
          songs: [song(2, "Harbor Light")],
          clips: [clip(9, "Station ident")],
        }}
      />
    </MemoryRouter>,
  );
  await openBlock();
  fireEvent.click(screen.getByRole("button", { name: "Fillers" }));
  expect(
    screen.getByRole("option", { name: "Music rotation" }),
  ).toBeInTheDocument();
  // A fixture block is never sent to the filler service.
  expect(screen.getByRole("combobox", { name: "Filler tag" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Build block" }));
  expect(
    screen.getByRole("button", { name: "Generate for nothing" }),
  ).toBeVisible();
  expect(fetchAllMediaLabels).not.toHaveBeenCalled();
  expect(fetchFlightSequences).not.toHaveBeenCalled();
});
