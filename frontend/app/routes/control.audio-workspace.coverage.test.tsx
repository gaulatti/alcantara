import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { controlServer, stubConsoleBrowser, type ControlServer } from "../../test/controlKit";

// gaulatti/alcantara#194: the TV console's audio workspace. Its music list,
// playback bar, playlist sheet and cartwall reach the same audio bus, radio,
// off-air and instant requests as the radio console.

vi.mock("../hooks/useSSE", () => ({ useSSE: () => ({ isConnected: true }) }));
vi.mock("../utils/globalProgram", () => ({ useGlobalProgramId: () => ["main"] }));
vi.mock("../contexts/ConsolePreferencesContext", async (original) => {
  const actual = await original<typeof import("../contexts/ConsolePreferencesContext")>();
  return {
    ...actual,
    useConsolePreferences: () => ({
      profile: { ...actual.defaultConsoleProfile("desktop"), workspace: "audio" },
      updateProfile: vi.fn(),
    }),
  };
});

import Control from "./control";

let server: ControlServer;

const song = (id: string, title: string) => ({
  id,
  kind: "preset",
  songId: Number(id.slice(1)),
  artist: "Fictional artist",
  title,
  coverUrl: "https://media.example.test/cover.jpg",
  audioUrl: `https://media.example.test/${id}.mp3`,
  durationMs: 180_000,
});
const rotation = {
  mode: "manual",
  items: [song("s1", "Fictional opener"), song("s2", "Fictional closer")],
  activeItemId: "s1",
  loop: true,
};

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  stubConsoleBrowser();
  server = controlServer({
    "GET /scenes": Response.json([]),
    "GET /instants": Response.json([
      { id: 1, name: "Fictional bell", audioUrl: "https://media.example.test/bell.mp3", volume: 1, enabled: true, position: 0 },
    ]),
    "GET /songs?limit=0": Response.json({
      data: [{ id: 9, enabled: true, title: "Fictional catalog song", artist: "Fictional artist", audioUrl: "https://media.example.test/c9.mp3", durationMs: 120000 }],
    }),
    "GET /program/main/state": Response.json({
      id: 1,
      programId: "main",
      type: "tv",
      activeSceneId: null,
      fadeToBlack: false,
      scenes: [],
      mediaGroups: [],
    }),
    "GET /program/main/media-groups": Response.json([]),
    "GET /program/main/audio-bus": Response.json({ songSequence: rotation, songQueue: [] }),
    "PUT /program/main/audio-bus": () => {
      const sent = server.calls.filter((call) => call.method === "PUT").at(-1)?.body as { songSequence: unknown };
      return Response.json({ songSequence: sent.songSequence });
    },
    "POST /radio/main/song": Response.json({}),
    "POST /program/main/song/off-air": Response.json({}),
    "POST /instants/1/play?programId=main": Response.json({}),
    "POST /instants/stop-all?programId=main": Response.json({}),
  });
  render(
    <MemoryRouter>
      <Control />
    </MemoryRouter>,
  );
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("takes a song on air from the music list and the playback bar, and steps the rotation", async () => {
  const takes = await screen.findAllByRole("button", { name: "Take on air" });
  fireEvent.click(takes[1]);
  await waitFor(() => expect(server.requests("POST /radio/main/song")).toHaveLength(1));
  expect(server.requests("POST /radio/main/song")[0]).toMatchObject({ title: "Fictional closer" });

  // Turning loop off in the playback bar saves the rotation without a take.
  const saves = server.requests("PUT /program/main/audio-bus").length;
  fireEvent.click(screen.getByRole("button", { name: "Loop playlist: on" }));
  await waitFor(() => expect(server.requests("PUT /program/main/audio-bus").length).toBe(saves + 1));
  expect((server.requests("PUT /program/main/audio-bus").at(-1) as { songSequence: { loop: boolean } }).songSequence.loop).toBe(false);
  expect(server.requests("POST /radio/main/song")).toHaveLength(1);

  fireEvent.click(await screen.findByRole("button", { name: "Play selection" }));
  await waitFor(() => expect(server.requests("POST /radio/main/song")).toHaveLength(2));
});

it("takes the song off air and stops every instant from the playback bar", async () => {
  fireEvent.click(await screen.findByRole("button", { name: "Stop / Take Off Air" }));
  await waitFor(() => expect(server.requests("POST /program/main/song/off-air")).toHaveLength(1));
  fireEvent.click(screen.getByRole("button", { name: "Stop All Instants" }));
  await waitFor(() => expect(server.requests("POST /instants/stop-all?programId=main")).toHaveLength(1));
});

it("plays and stops instants from the audio workspace's cartwall", async () => {
  const cartwall = await screen.findByRole("region", { name: "Cartwall" });
  fireEvent.click(within(cartwall).getByRole("button", { name: "Fictional bell" }));
  await waitFor(() => expect(server.requests("POST /instants/1/play?programId=main")).toHaveLength(1));
  fireEvent.click(within(cartwall).getByRole("button", { name: "Stop all" }));
  await waitFor(() => expect(server.requests("POST /instants/stop-all?programId=main")).toHaveLength(1));
});

it("opens the playlist sheet from Add songs, and adds a catalog song to the rotation", async () => {
  fireEvent.click(await screen.findByRole("button", { name: "Add songs" }));
  const sheet = await screen.findByRole("dialog");
  const saves = server.requests("PUT /program/main/audio-bus").length;
  fireEvent.click(within(sheet).getAllByRole("button", { name: /^Add .+ to the playlist$/ })[0]);
  await waitFor(() => expect(server.requests("PUT /program/main/audio-bus").length).toBe(saves + 1));
  const [, ...rest] = server.requests("PUT /program/main/audio-bus") as Array<{ songSequence: { items: Array<{ title: string }> } }>;
  const last = (rest.at(-1) ?? server.requests("PUT /program/main/audio-bus")[0]) as { songSequence: { items: Array<{ title: string }> } };
  expect(last.songSequence.items.map((item) => item.title)).toContain("Fictional catalog song");
});
