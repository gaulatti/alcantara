import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { controlServer, stubConsoleBrowser, type ControlServer } from "../../test/controlKit";

// gaulatti/alcantara#194 group 3: the scene editor. Editing the staged scene's
// components saves its metadata (on its own after a pause, or at once with
// Save changes); a failed save is shown and retried; the scene's background
// audio is chosen, taken and stopped from the editor.

vi.mock("../hooks/useSSE", () => ({ useSSE: () => ({ isConnected: true }) }));
vi.mock("../utils/globalProgram", () => ({ useGlobalProgramId: () => ["main"] }));
vi.mock("../contexts/ConsolePreferencesContext", async (original) => {
  const actual = await original<typeof import("../contexts/ConsolePreferencesContext")>();
  return {
    ...actual,
    useConsolePreferences: () => ({
      profile: actual.defaultConsoleProfile("desktop"),
      updateProfile: vi.fn(),
    }),
  };
});

// The design system's Select is a native select here, as in the bracket
// editor's own tests, so a ballot can be cast with a change event.
vi.mock("@gaulatti/bleecker", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@gaulatti/bleecker")>();
  return {
    ...actual,
    Select: ({ options, onChange, value, ...rest }: any) => (
      <select {...rest} value={value} onChange={(event) => onChange(event.target.value)}>
        {options.map((option: any) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    ),
  };
});

import Control from "./control";

let server: ControlServer;

const playerScene = (
  metadata: Record<string, unknown> = { header: { show: false } },
  componentType = "header",
) => ({
  id: 1,
  name: "Fictional player scene",
  layoutId: 1,
  metadata: JSON.stringify(metadata),
  layout: { id: 1, name: "Fixture layout", componentType },
});

function open(metadata?: Record<string, unknown>, componentType?: string, songs: unknown[] = []) {
  const scene = playerScene(metadata, componentType);
  server = controlServer({
    "GET /scenes": Response.json([scene]),
    "GET /instants": Response.json([]),
    "GET /songs?limit=0": Response.json({ data: songs }),
    "GET /program/main/state": Response.json({
      id: 1,
      programId: "main",
      type: "tv",
      activeSceneId: null,
      stagedSceneId: 1,
      stagedScene: scene,
      fadeToBlack: false,
      scenes: [{ id: 1, sceneId: 1, position: 0, scene }],
      mediaGroups: [],
    }),
    "GET /program/main/media-groups": Response.json([]),
    "GET /media-assets?mediaType=AUDIO&capability=BACKGROUND&limit=200": Response.json({
      data: [{ id: "a1", name: "Fictional rain", enabled: true }],
    }),
  });
  render(
    <MemoryRouter>
      <Control />
    </MemoryRouter>,
  );
  return scene;
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  stubConsoleBrowser();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("saves an edit to the staged scene on its own, and at once with Save changes", async () => {
  const scene = open();
  server.answer("PUT /scenes/1", () =>
    Response.json({ ...scene, metadata: JSON.stringify({ header: { show: true } }) }),
  );
  fireEvent.click(await screen.findByRole("button", { name: "Show component" }));
  await waitFor(() => expect(server.requests("PUT /scenes/1").length).toBeGreaterThan(0), { timeout: 4000 });
  expect(server.requests("PUT /scenes/1")[0]).toMatchObject({ metadata: { header: { show: true } } });
  const saves = server.requests("PUT /scenes/1").length;
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(server.requests("PUT /scenes/1").length).toBe(saves + 1));
});

it("retries a failed autosave until it lands, and shows a refused save on request", async () => {
  const scene = open();
  let fail = true;
  server.answer("PUT /scenes/1", () =>
    fail
      ? new Response("down", { status: 500 })
      : Response.json({ ...scene, metadata: JSON.stringify({ header: { show: true } }) }),
  );
  fireEvent.click(await screen.findByRole("button", { name: "Show component" }));
  expect(await screen.findByText("Scene save failed. Retrying...", {}, { timeout: 4000 })).toBeVisible();
  fail = false;
  await waitFor(() => expect(screen.queryByText("Scene save failed. Retrying...")).toBeNull(), { timeout: 4000 });
  // Save changes against a refusing server says so.
  fail = true;
  fireEvent.click(await screen.findByRole("button", { name: "Save changes" }));
  expect(await screen.findByText("Scene save failed. Please try again.")).toBeVisible();
});


it("chooses, takes and stops the scene's background audio", async () => {
  const scene = open(
    { player: { show: true }, sceneInstant: { assetId: "a1", instantId: null, volume: 0.5 } },
    "player",
  );
  server.answer("PUT /scenes/1", () => Response.json(scene));
  server.answer("POST /program/main/scene-instant/take", Response.json({ sceneId: 1, mediaAssetId: "a1", isPlaying: true, instant: { name: "Fictional rain" } }));
  server.answer("POST /program/main/scene-instant/stop", Response.json({ sceneId: 1, isPlaying: false }));
  fireEvent.click(await screen.findByRole("button", { name: "TAKE BG" }));
  await waitFor(() =>
    expect(server.requests("POST /program/main/scene-instant/take")).toEqual([
      { sceneId: 1, instantId: null, mediaAssetId: "a1" },
    ]),
  );
  fireEvent.click(await screen.findByRole("button", { name: "STOP BG" }));
  await waitFor(() => expect(server.calls.some((call) => call.path === "/program/main/scene-instant/stop")).toBe(true));
});

// What the editor starts from for each component of a staged scene: its
// defaults, then the scene's own settings, reading the older shared keys
// (fifthbell, toni-chyron, toni-clock) where a component kept them before.
it.each([
  ["fifthbell-content", {}, (props: any) => expect(Array.isArray(props.weatherCities) && props.weatherCities.length).toBeTruthy()],
  ["reloj-digital-loop-clock", {}, (props: any) => expect(props.textSequence?.items?.length).toBe(1)],
  ["modoitaliano-chyron", {}, (props: any) => expect(props.ctaSequence?.items?.length).toBe(1)],
  ["modoitaliano-giorgia-chyron", {}, (props: any) => expect(props.textSequence?.items?.[0]?.useMarquee).toBe(false)],
  ["fifthbell", {}, (props: any) => expect(Array.isArray(props.weatherCities)).toBe(true)],
  ["fifthbell-marquee", { fifthbell: { tone: "legacy" }, "fifthbell-marquee": { speed: 3 } }, (props: any) => expect(props).toMatchObject({ tone: "legacy", speed: 3 })],
  ["fifthbell-chyron", { "toni-chyron": { a: 1 }, "fifthbell-chyron": { b: 2 } }, (props: any) => expect(props).toMatchObject({ a: 1, b: 2 })],
  ["fifthbell-corner", { fifthbell: { c: 1 }, "toni-clock": { d: 2 }, "fifthbell-corner": { e: 3 } }, (props: any) => expect(props).toMatchObject({ c: 1, d: 2, e: 3 })],
])("saves %s with its defaults and the scene's own settings", async (componentType, metadata, check) => {
  const scene = open(metadata as Record<string, unknown>, componentType as string);
  server.answer("PUT /scenes/1", () => Response.json(scene));
  fireEvent.click(await screen.findByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(server.requests("PUT /scenes/1").length).toBeGreaterThan(0));
  const [saved] = server.requests("PUT /scenes/1") as Array<{ metadata: Record<string, unknown> }>;
  (check as (props: unknown) => void)(saved.metadata[componentType as string]);
});

it("switches the chyron to a sequence and takes a value live, saving each change", async () => {
  const scene = open({ "toni-chyron": { contentMode: "text", text: "Fictional line" } }, "toni-chyron");
  // The server stores what it is sent and answers with it.
  const echo = () => {
    const sent = server.calls.filter((call) => call.method === "PUT").at(-1)?.body as { metadata: unknown };
    return Response.json({ ...scene, metadata: JSON.stringify(sent.metadata) });
  };
  server.answer("PUT /scenes/1", echo);
  fireEvent.click(await screen.findByRole("button", { name: "Sequence" }));
  await waitFor(() =>
    expect(
      (server.requests("PUT /scenes/1") as Array<{ metadata: Record<string, any> }>).some(
        (body) => body.metadata["toni-chyron"]?.contentMode === "sequence",
      ),
    ).toBe(true),
    { timeout: 4000 },
  );
  const before = server.requests("PUT /scenes/1").length;
  fireEvent.click(screen.getAllByRole("button", { name: "Take" })[0]);
  // Taking a value saves at once instead of waiting for the autosave.
  await waitFor(() => expect(server.requests("PUT /scenes/1").length).toBeGreaterThan(before));

  // A take the server refuses keeps the editor open with the change.
  server.answer("PUT /scenes/1", new Response("down", { status: 500 }));
  fireEvent.click(screen.getAllByRole("button", { name: "Take" })[0]);
  expect(await screen.findByText(/Scene save failed/)).toBeVisible();
});

it("records a bracket ballot through the scene and shows what the scene then holds", async () => {
  const type = "modoitaliano-bracket";
  const bracket = {
    matches: [{ id: 1, songAId: 1, songBId: 2, winnerId: null }],
    voters: [{ id: "v1", name: "Fictional voter" }],
  };
  const scene = open({ [type]: bracket }, type, [
    { id: 1, title: "Fictional A", artist: "Fictional artist", audioUrl: "https://media.example.test/a.mp3" },
    { id: 2, title: "Fictional B", artist: "Fictional artist", audioUrl: "https://media.example.test/b.mp3" },
  ]);
  server.answer("PUT /scenes/1", () => Response.json(scene));
  server.answer("POST /scenes/1/modo-italiano-bracket/voting/open", Response.json({}));
  server.answer(
    "POST /scenes/1/modo-italiano-bracket/vote",
    Response.json({ ...scene, metadata: JSON.stringify({ [type]: { ...bracket, matchVotes: { 1: { v1: 2 } } } }) }),
  );
  const votes = await screen.findAllByRole("button", { name: "Vote" });
  fireEvent.click(votes[0]);
  expect(await screen.findByText("Ballots")).toBeVisible();
  const ballotLabel = screen
    .getAllByText("Fictional voter")
    .map((element) => element.closest("label"))
    .find((label) => label && within(label).queryByRole("combobox")) as HTMLElement;
  const ballot = within(ballotLabel).getByRole("combobox") as HTMLSelectElement;
  fireEvent.change(ballot, { target: { value: "2" } });
  await waitFor(() =>
    expect(server.requests("POST /scenes/1/modo-italiano-bracket/vote")).toEqual([
      { componentType: type, matchId: 1, voterId: "v1", songId: 2 },
    ]),
  );
  await waitFor(() => expect(ballot.value).toBe("2"));
  // A ballot the server refuses falls back to what the editor held.
  server.answer("POST /scenes/1/modo-italiano-bracket/vote", new Response("no", { status: 500 }));
  fireEvent.change(ballot, { target: { value: "1" } });
  await waitFor(() => expect(server.requests("POST /scenes/1/modo-italiano-bracket/vote")).toHaveLength(2));
});
