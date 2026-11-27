import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { controlServer, stubConsoleBrowser, type ControlServer } from "../../test/controlKit";

// gaulatti/alcantara#404 (control.tsx remainder, audio-bus callbacks and recording): a rotation edit on the radio
// desk and a playlist edit on the TV music list reach the audio bus; a refused save is reported, and the recording
// panels open from the program recording summary.
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

function open(programType: "tv" | "radio", rotationRefused = false) {
  server = controlServer({
    "GET /scenes": Response.json([]),
    "GET /instants": Response.json([]),
    "GET /songs?limit=0": Response.json({ data: [{ id: 9, enabled: true, title: "Fictional catalog song", artist: "Fictional artist", audioUrl: "https://media.example.test/c9.mp3", durationMs: 120000 }] }),
    "GET /program/main/state": Response.json({ id: 1, programId: "main", type: programType, activeSceneId: null, fadeToBlack: false, scenes: [], mediaGroups: [] }),
    "GET /program/main/media-groups": Response.json([]),
    "GET /program/main/audio-bus": Response.json({ songSequence: rotation, songQueue: [] }),
    "PUT /program/main/audio-bus": () => {
      if (rotationRefused) return new Response("down", { status: 500 });
      const sent = server.calls.filter((call) => call.method === "PUT").at(-1)?.body as { songSequence: unknown };
      return Response.json({ songSequence: sent.songSequence });
    },
    "POST /radio/main/song": Response.json({}),
    "POST /program/main/song/off-air": Response.json({}),
    "POST /instants/1/play?programId=main": Response.json({}),
    "POST /instants/stop-all?programId=main": Response.json({}),
  });
  render(<MemoryRouter><Control /></MemoryRouter>);
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  stubConsoleBrowser();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("removes a song from the TV music list and saves the rotation without it", async () => {
  open("tv");
  const list = await screen.findByRole("list", { name: "Songs" }).catch(() => null);
  const removers = await screen.findAllByRole("button", { name: /^Remove / });
  const saves = server.requests("PUT /program/main/audio-bus").length;
  fireEvent.click(removers[0]);
  await waitFor(() => expect(server.requests("PUT /program/main/audio-bus").length).toBe(saves + 1));
  const sent = server.requests("PUT /program/main/audio-bus").at(-1) as { songSequence: { items: Array<{ title: string }> } };
  expect(sent.songSequence.items.map((item) => item.title)).not.toContain("Fictional opener");
  void list;
}, 15000);

it("puts a rotation song into high rotation from the radio desk and saves it", async () => {
  open("radio");
  const add = await screen.findByRole("button", { name: "Add Fictional closer to high rotation" });
  const saves = server.requests("PUT /program/main/audio-bus").length;
  fireEvent.click(add);
  await waitFor(() => expect(server.requests("PUT /program/main/audio-bus").length).toBe(saves + 1));
  const sent = server.requests("PUT /program/main/audio-bus").at(-1) as { songSequence: { items: Array<{ title: string; highRotation?: boolean }> } };
  expect(sent.songSequence.items.find((item) => item.title === "Fictional closer")?.highRotation).toBe(true);
}, 15000);

it("says a rotation the server refuses was not changed", async () => {
  open("radio", true);
  fireEvent.click(await screen.findByRole("button", { name: "Add Fictional closer to high rotation" }));
  await waitFor(() => {
    const alerts = screen.getAllByRole("alert");
    expect(alerts.some((alert) => /not changed|500|down|failed|HTTP/i.test(alert.textContent ?? ""))).toBe(true);
  }, { timeout: 4000 });
}, 15000);

it("opens the program recording panels from the recording summary", async () => {
  open("tv");
  const summary = (await screen.findAllByText("Program recording"))[0];
  fireEvent.click(summary);
  await waitFor(() => expect(summary.closest("details")?.open).toBe(true));
  fireEvent.click(summary);
  await waitFor(() => expect(summary.closest("details")?.open).toBe(false));
}, 15000);
