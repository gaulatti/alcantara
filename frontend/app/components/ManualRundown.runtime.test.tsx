import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Provider } from "react-redux";
import { legacy_createStore } from "redux";
import { reducers } from "../state/reducers";
import { ConsolePreferencesProvider } from "../contexts/ConsolePreferencesContext";
import ManualRundown from "./ManualRundown";
import type { FlightCue, FlightSequence } from "../models/broadcast";

vi.mock("../utils/apiBaseUrl", () => ({
  getApiBaseUrl: () => "https://rundown.example",
  apiUrl: (path: string) => `https://rundown.example${path}`,
}));
// Only the network/browser boundary is replaced; all cue editing, services,
// runtime reconciliation, preferences and design-system controls remain real.
class FixtureEventSource {
  static current: FixtureEventSource;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  close = vi.fn();
  constructor(readonly url: string) {
    FixtureEventSource.current = this;
  }
  emit(data: unknown) {
    act(() => this.onmessage?.({ data: JSON.stringify(data) }));
  }
}
let sequences: FlightSequence[];
let activeSequenceId: number | null;
let requests: { method: string; path: string; body: any }[];
let failures: Record<string, number>;
let unexpected: string[];
const makeSequence = (id: number, items: FlightCue[] = []): FlightSequence => ({
  id,
  name: `Studio rundown ${id}`,
  items,
  loop: false,
  isRunning: false,
  activeItemId: null,
  scheduledAt: null,
  publishedAt: null,
  revision: 1,
  lastStartedAt: null,
  createdAt: "2026-10-24T12:00:00Z",
  updatedAt: "2026-10-24T12:00:00Z",
});
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
async function transport(input: RequestInfo | URL, init?: RequestInit) {
  const path = new URL(String(input)).pathname;
  const method = init?.method ?? "GET";
  const body = init?.body ? JSON.parse(String(init.body)) : null;
  requests.push({ method, path, body });
  if (failures[`${method} ${path}`])
    return json(
      { message: "Fixture command rejected" },
      failures[`${method} ${path}`],
    );
  if (path === "/operator-preferences/desktop")
    return json({
      version: 1,
      profile: {
        workspace: "director",
        dockWidth: 320,
        touchMode: false,
        shortcutsEnabled: true,
        selectedProgramId: "main",
        transitions: { main: "cut" },
      },
    });
  if (path === "/songs") return json({ data: [] });
  if (path === "/instants") return json([]);
  if (path === "/program/main/state")
    return json({ activeFlightSequenceId: activeSequenceId, scenes: [] });
  if (path === "/program/main/flight") {
    if (method === "POST") {
      const created = { ...makeSequence(3), ...body };
      sequences.push(created);
      return json(created);
    }
    return json(sequences);
  }
  const match = path.match(/^\/program\/main\/flight\/(\d+)$/);
  if (match) {
    const id = Number(match[1]);
    if (method === "PUT") {
      sequences = sequences.map((sequence) =>
        sequence.id === id ? { ...sequence, ...body } : sequence,
      );
      return json(sequences.find((sequence) => sequence.id === id));
    }
    if (method === "DELETE") {
      sequences = sequences.filter((sequence) => sequence.id !== id);
      return json({ deletedId: id });
    }
  }
  if (
    method === "POST" &&
    /^\/program\/main\/flight\/(start|stop|go|reset)$/.test(path)
  )
    return json({ ok: true });
  if (method === "POST" && path === "/program/main/flight/deactivate") {
    activeSequenceId = null;
    return json({ activeSequenceId });
  }
  if (method === "POST" && path.endsWith("/activate")) {
    activeSequenceId = Number(path.split("/").at(-2));
    return json({ activeSequenceId });
  }
  unexpected.push(`${method} ${path}`);
  return json({}, 500);
}
beforeEach(() => {
  sequences = [
    makeSequence(1, [
      { id: "cue-one", kind: "wait", durationMs: 1000, label: "Hold opener" },
      { id: "cue-two", kind: "stopSong", label: "Silence music" },
    ]),
  ];
  activeSequenceId = 1;
  requests = [];
  failures = {};
  unexpected = [];
  localStorage.clear();
  vi.stubGlobal("innerWidth", 1600);
  vi.stubGlobal("fetch", vi.fn(transport));
  vi.stubGlobal("EventSource", FixtureEventSource);
  vi.spyOn(window, "confirm").mockReturnValue(true);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  expect(unexpected).toEqual([]);
});
async function mount() {
  const store = legacy_createStore(reducers, {
    auth: {
      loaded: true,
      currentUser: { id: "operator-a", email: "operator@example.invalid" },
    },
    preferences: { selectedLanguage: "en" },
  } as any);
  const view = render(
    <Provider store={store}>
      <ConsolePreferencesProvider>
        <ManualRundown />
      </ConsolePreferencesProvider>
    </Provider>,
  );
  await screen.findByRole("button", {
    name: sequences.length ? "New rundown" : "Create rundown",
  });
  if (sequences.length) await screen.findByText("Runtime");
  return view;
}
const writes = () => requests.filter((request) => request.method === "PUT");
it("loads the active rundown and its editable cues", async () => {
  await mount();
  expect(screen.getByDisplayValue("Hold opener")).toBeInTheDocument();
  expect(screen.getByDisplayValue("Silence music")).toBeInTheDocument();
  expect(screen.getByText("Cue 0 of 2")).toBeInTheDocument();
  expect(screen.getAllByRole("button", { name: "Move up" })[0]).toBeDisabled();
  expect(
    screen.getAllByRole("button", { name: "Move down" })[1],
  ).toBeDisabled();
});
it("omits scheduled logs from the manually operated rundown choices", async () => {
  sequences.push({
    ...makeSequence(2),
    name: "Scheduled bulletin",
    scheduledAt: "2026-10-25T12:00:00Z",
  });
  activeSequenceId = null;
  await mount();
  expect(screen.getByText("No active rundown.")).toBeInTheDocument();
  expect(screen.queryByText("Scheduled bulletin")).not.toBeInTheDocument();
  expect(
    screen.getByText("Select or create a sequence to edit cues."),
  ).toBeInTheDocument();
});
it("shows an empty repository without inventing a rundown", async () => {
  sequences = [];
  activeSequenceId = null;
  await mount();
  expect(screen.getByText("No rundowns yet")).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Create rundown" }),
  ).toBeInTheDocument();
});
it("persists cue labels and wait durations through real inputs", async () => {
  await mount();
  fireEvent.change(screen.getByDisplayValue("Hold opener"), {
    target: { value: "Hold interview" },
  });
  await waitFor(() => expect(writes()).toHaveLength(1));
  expect(writes()[0].body.items[0].label).toBe("Hold interview");
  fireEvent.change(screen.getByRole("spinbutton", { name: "Duration (ms)" }), {
    target: { value: "2400" },
  });
  await waitFor(() => expect(writes()).toHaveLength(2));
  expect(writes()[1].body.items[0].durationMs).toBe(2400);
});
it("reorders cues and removes the selected cue without changing the others", async () => {
  await mount();
  fireEvent.click(screen.getAllByRole("button", { name: "Move down" })[0]);
  await waitFor(() => expect(writes()).toHaveLength(1));
  expect(writes()[0].body.items.map((cue: FlightCue) => cue.id)).toEqual([
    "cue-two",
    "cue-one",
  ]);
  fireEvent.click(screen.getAllByRole("button", { name: "Delete cue" })[0]);
  await waitFor(() => expect(writes()).toHaveLength(2));
  expect(writes()[1].body.items.map((cue: FlightCue) => cue.id)).toEqual([
    "cue-one",
  ]);
});
it("moves a later cue upward", async () => {
  await mount();
  fireEvent.click(screen.getAllByRole("button", { name: "Move up" })[1]);
  await waitFor(() => expect(writes()).toHaveLength(1));
  expect(writes()[0].body.items[0].id).toBe("cue-two");
});
it("toggles the persisted loop without changing cue order", async () => {
  await mount();
  fireEvent.click(screen.getByRole("button", { name: "Loop off" }));
  await screen.findByRole("button", { name: "Loop on" });
  expect(writes()[0].body).toEqual({ loop: true });
  expect(sequences[0].items[0].id).toBe("cue-one");
});
it.each([
  ["Switch scene", "scene"],
  ["Play song", "playSong"],
  ["Stop song", "stopSong"],
  ["Instant", "instant"],
  ["Mixer", "mixer"],
  ["Wait", "wait"],
  ["Wait for song end", "waitForSongEnd"],
  ["Update scene", "sceneUpdate"],
])("adds a %s cue through its actual editor action", async (label, kind) => {
  await mount();
  fireEvent.click(screen.getByRole("button", { name: label }));
  await waitFor(() => expect(writes()).toHaveLength(1));
  const items: FlightCue[] = writes()[0].body.items;
  expect(items).toHaveLength(3);
  expect(items.slice(0, 2).map((cue) => cue.id)).toEqual([
    "cue-one",
    "cue-two",
  ]);
  expect(items[2]).toMatchObject({ id: expect.stringMatching(/^cue_/), kind });
  if (kind === "scene") expect(items[2].transitionId).toBe("cut");
  if (kind === "wait") expect(items[2].durationMs).toBe(3000);
});
it.each([
  ["Start", "start"],
  ["GO", "go"],
  ["Reset", "reset"],
])("sends %s to the authoritative runtime", async (label, operation) => {
  await mount();
  fireEvent.click(screen.getByRole("button", { name: label }));
  await waitFor(() =>
    expect(
      requests.some(
        (request) =>
          request.method === "POST" &&
          request.path === `/program/main/flight/${operation}`,
      ),
    ).toBe(true),
  );
});
it("restores an already-running cue on bootstrap and permits stop", async () => {
  sequences[0] = { ...sequences[0], isRunning: true, activeItemId: "cue-one" };
  await mount();
  expect(screen.getByText("Active")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Stop" }));
  await waitFor(() =>
    expect(
      requests.some((request) => request.path === "/program/main/flight/stop"),
    ).toBe(true),
  );
});
it("updates runtime position from the real event stream and ignores other programs", async () => {
  await mount();
  FixtureEventSource.current.emit({
    type: "flight_update",
    programId: "main",
    activeSequenceId: 1,
    runtime: {
      sequenceId: 1,
      activeIndex: 1,
      isRunning: true,
      waitingForSongEnd: true,
      activeItemId: "cue-two",
      totalItems: 2,
      loop: false,
    },
  });
  await screen.findByText("Waiting for song to end…");
  expect(screen.getByText("Cue 2 of 2")).toBeInTheDocument();
  FixtureEventSource.current.emit({
    type: "flight_update",
    programId: "other",
    activeSequenceId: null,
    runtime: null,
  });
  FixtureEventSource.current.emit(null);
  expect(screen.getByText("Cue 2 of 2")).toBeInTheDocument();
});
it("honors a server-side deactivation", async () => {
  await mount();
  FixtureEventSource.current.emit({
    type: "flight_update",
    programId: "main",
    activeSequenceId: null,
    runtime: null,
  });
  await screen.findByText("No active rundown.");
  expect(
    screen.queryByRole("button", { name: "Start" }),
  ).not.toBeInTheDocument();
});
it("requires confirmation before deleting an active rundown", async () => {
  await mount();
  vi.mocked(window.confirm).mockReturnValueOnce(false);
  fireEvent.click(screen.getByRole("button", { name: "Delete" }));
  expect(requests.some((request) => request.method === "DELETE")).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Delete" }));
  await screen.findByText("No rundowns yet");
  expect(requests.find((request) => request.method === "DELETE")?.path).toBe(
    "/program/main/flight/1",
  );
});
it("keeps saved cues visible and reports a rejected edit", async () => {
  await mount();
  failures["PUT /program/main/flight/1"] = 409;
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  fireEvent.change(screen.getByDisplayValue("Hold opener"), {
    target: { value: "Rejected label" },
  });
  await waitFor(() =>
    expect(errors).toHaveBeenCalledWith(
      "Failed to save flight sequence:",
      expect.any(Error),
    ),
  );
  expect(sequences[0].items[0].label).toBe("Hold opener");
  expect(screen.getByDisplayValue("Hold opener")).toBeInTheDocument();
  expect(
    screen.getAllByText("Fixture command rejected").length,
  ).toBeGreaterThan(0);
});
it("closes the event stream on unmount", async () => {
  const view = await mount();
  const stream = FixtureEventSource.current;
  view.unmount();
  expect(stream.close).toHaveBeenCalledOnce();
});
