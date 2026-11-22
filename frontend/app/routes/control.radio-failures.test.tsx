import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { controlServer, stubConsoleBrowser, type ControlServer } from "../../test/controlKit";

// gaulatti/alcantara#253: the radio console shows the operator what failed. A
// refused instant or Stop all is shown by the cartwall until the next one
// starts; a song library or cartwall that did not load says so with a retry,
// not as an empty list; and a refusal reads the server's own reason.

vi.mock("../hooks/useSSE", () => ({ useSSE: () => ({ isConnected: false }) }));
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

import Control from "./control";

let server: ControlServer;

const song = {
  id: "s1",
  kind: "preset",
  songId: 11,
  artist: "Fictional artist",
  title: "Fictional closer",
  coverUrl: "https://media.example.test/cover.jpg",
  audioUrl: "https://media.example.test/s1.mp3",
  durationMs: 180_000,
};
const bell = { id: 1, name: "Fictional bell", audioUrl: "https://media.example.test/bell.mp3", volume: 1, enabled: true, position: 0 };
const sting = { id: 2, name: "Fictional sting", audioUrl: "https://media.example.test/sting.mp3", volume: 1, enabled: true, position: 1 };
const refusal = (message: unknown, status = 409) => () => Response.json({ statusCode: status, message }, { status });

function open(routes: Record<string, Response | (() => Response)> = {}) {
  server = controlServer({
    "GET /scenes": Response.json([]),
    "GET /instants": () => Response.json([bell, sting]),
    "GET /songs?limit=0": () => Response.json({ data: [] }),
    "GET /program/main/state": Response.json({
      id: 1,
      programId: "main",
      type: "radio",
      activeSceneId: null,
      fadeToBlack: false,
      scenes: [],
      mediaGroups: [],
    }),
    "GET /program/main/media-groups": Response.json([]),
    "GET /program/main/audio-bus": () =>
      Response.json({
        songSequence: { mode: "manual", items: [song], activeItemId: "s1", loop: true },
        songQueue: [],
      }),
    ...routes,
  });
  render(
    <MemoryRouter>
      <Control />
    </MemoryRouter>,
  );
}

const cartwall = () => screen.findByRole("region", { name: "Cartwall" });

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

it("shows a refused instant by the cartwall with the server's reason, and clears it when the next one starts", async () => {
  open({
    "POST /instants/1/play?programId=main": refusal("Fictional bell is disabled for this program"),
    "POST /instants/2/play?programId=main": () => Response.json({}),
  });
  const wall = await cartwall();
  fireEvent.click(await within(wall).findByRole("button", { name: "Fictional bell" }));
  expect(
    await within(wall).findByText("Could not play Fictional bell: Fictional bell is disabled for this program"),
  ).toBeVisible();

  // The next instant clears the refusal as it starts, and it plays.
  fireEvent.click(within(wall).getByRole("button", { name: "Fictional sting" }));
  await waitFor(() => expect(within(wall).queryByText(/Could not play/)).toBeNull());
  expect(await within(wall).findByRole("button", { name: "Fictional sting · playing" })).toBeVisible();
});

it("shows a refused Stop all with the status when the server gives no reason, and clears it on the next try", async () => {
  let refuse = true;
  open({
    "POST /instants/stop-all?programId=main": () =>
      refuse ? new Response("<html>Bad gateway</html>", { status: 502, headers: { "content-type": "text/html" } }) : Response.json({}),
  });
  const wall = await cartwall();
  fireEvent.click(within(wall).getByRole("button", { name: "Stop all" }));
  const alert = await within(wall).findByText("Could not stop all instants: HTTP 502");
  expect(alert).toBeVisible();
  // The body is never shown, as text or as markup.
  expect(screen.queryByText(/Bad gateway/)).toBeNull();

  refuse = false;
  fireEvent.click(within(wall).getByRole("button", { name: "Stop all" }));
  await waitFor(() => expect(server.requests("POST /instants/stop-all?programId=main")).toHaveLength(2));
  await waitFor(() => expect(within(wall).queryByText(/Could not stop all/)).toBeNull());
});

it("says the cartwall did not load instead of showing an empty one, and a retry loads it", async () => {
  let fail = true;
  open({
    "GET /instants": () => (fail ? refusal("Fictional library is offline", 503)() : Response.json([bell])),
  });
  const wall = await cartwall();
  expect(await within(wall).findByText("Cartwall did not load: Fictional library is offline")).toBeVisible();
  expect(within(wall).queryByText("No instants in catalog.")).toBeNull();

  fail = false;
  fireEvent.click(within(wall).getByRole("button", { name: "Retry cartwall" }));
  expect(await within(wall).findByRole("button", { name: "Fictional bell" })).toBeVisible();
  expect(within(wall).queryByText(/Cartwall did not load/)).toBeNull();
});

it("still says No instants in catalog when the cartwall loaded empty", async () => {
  open({ "GET /instants": () => Response.json([]) });
  const wall = await cartwall();
  expect(await within(wall).findByText("No instants in catalog.")).toBeVisible();
  expect(screen.queryByText(/did not load/)).toBeNull();
});

it("says the song library did not load, keeps the cartwall that did, and a retry replaces the error", async () => {
  let fail = true;
  open({
    "GET /songs?limit=0": () => (fail ? new Response("down", { status: 503 }) : Response.json({ data: [] })),
  });
  expect(await screen.findByText("Song library did not load: HTTP 503")).toBeVisible();
  // Only the failed list shows an error: the cartwall loaded and is shown.
  const wall = await cartwall();
  expect(within(wall).getByRole("button", { name: "Fictional bell" })).toBeVisible();

  fail = false;
  const before = server.requests("GET /songs?limit=0").length;
  fireEvent.click(screen.getByRole("button", { name: "Retry song library" }));
  await waitFor(() => expect(server.requests("GET /songs?limit=0").length).toBe(before + 1));
  await waitFor(() => expect(screen.queryByText(/Song library did not load/)).toBeNull());
});

it("shows the server's reason for a refused Play Next add", async () => {
  open({
    "POST /program/main/song-queue": refusal(["Fictional closer is already next"], 422),
  });
  fireEvent.click(await screen.findByRole("button", { name: "Play Fictional closer next" }));
  expect(await screen.findByText("Fictional closer is already next")).toBeVisible();
  await act(async () => {});
  expect(screen.queryByText("HTTP 422")).toBeNull();
});
