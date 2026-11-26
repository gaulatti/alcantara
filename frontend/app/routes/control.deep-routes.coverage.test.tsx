import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  controlServer,
  stubConsoleBrowser,
  type Answer,
  type ControlServer,
} from "../../test/controlKit";

// gaulatti/alcantara#624 (control.tsx deep routes): the paths of the main console that need state traced to reach.
// - CUT takes the Preview to Program with the cut transition.
// - The playlist sheet closes from its own Close control.
// - A stored rotation whose active item is a nested sequence plays from the first song inside it, and has no active
//   song when that nested sequence is empty.
// - A song sequence the normaliser cannot read becomes an empty manual rotation, both when the stored sequence is
//   read for the music list and when an edited sequence is saved.
// - A Preview answer that arrives after the operator switched program, before the new program loaded, changes
//   nothing on screen.

const deep = vi.hoisted(() => ({
  program: "main",
  workspace: null as null | "audio",
  // A top-level song title the stand-in normaliser refuses to read, unless the sequence is the raw fixture.
  unreadableTitle: null as null | string,
}));

vi.mock("../hooks/useSSE", () => ({ useSSE: () => ({ isConnected: true }) }));
vi.mock("../utils/globalProgram", () => ({
  useGlobalProgramId: () => [deep.program],
}));
vi.mock("../contexts/ConsolePreferencesContext", async (original) => {
  const actual =
    await original<typeof import("../contexts/ConsolePreferencesContext")>();
  return {
    ...actual,
    useConsolePreferences: () => ({
      profile: {
        ...actual.defaultConsoleProfile("desktop"),
        ...(deep.workspace ? { workspace: deep.workspace } : {}),
      },
      updateProfile: vi.fn(),
    }),
  };
});
// The real normaliser, except that it answers null for a sequence that names the unreadable title and is not the
// raw server fixture (marked `fixtureRaw`, which normalising drops). That is how a sequence it cannot read reaches
// the console's fallbacks after the loaders have already accepted the stored one.
vi.mock("../utils/programSequence", async (original) => {
  const actual = await original<typeof import("../utils/programSequence")>();
  return {
    ...actual,
    normalizeProgramSongSequence: (value: unknown, depth?: number) => {
      const record = value as {
        fixtureRaw?: unknown;
        items?: Array<{ title?: unknown }>;
      } | null;
      if (
        deep.unreadableTitle &&
        record &&
        record.fixtureRaw !== true &&
        Array.isArray(record.items) &&
        record.items.some((item) => item?.title === deep.unreadableTitle)
      ) {
        return null;
      }
      return actual.normalizeProgramSongSequence(value, depth);
    },
  };
});

import Control from "./control";

let server: ControlServer;

const headlines = {
  id: 1,
  name: "Fictional headlines",
  layoutId: 1,
  metadata: {},
  layout: { id: 1, name: "Fixture layout", componentType: "toni-clock" },
};

const song = (id: string, title: string) => ({
  id,
  kind: "preset",
  songId: Number(id.replace(/\D/g, "")),
  artist: "Fictional artist",
  title,
  coverUrl: "https://media.example.test/cover.jpg",
  audioUrl: `https://media.example.test/${id}.mp3`,
  durationMs: 180_000,
});

function programState(
  programId: string,
  staged: typeof headlines | null = null,
) {
  return {
    id: programId === "main" ? 1 : 2,
    programId,
    type: "tv",
    version: 5,
    activeSceneId: null,
    stagedSceneId: staged?.id ?? null,
    stagedScene: staged,
    fadeToBlack: false,
    scenes: [{ id: 1, sceneId: headlines.id, position: 0, scene: headlines }],
    mediaGroups: [],
  };
}

function open(
  extra: Record<string, Answer> = {},
  staged: typeof headlines | null = null,
) {
  server = controlServer({
    "GET /scenes": Response.json([headlines]),
    "GET /instants": Response.json([]),
    "GET /songs?limit=0": Response.json({
      data: [
        {
          id: 9,
          enabled: true,
          title: "Fictional catalog song",
          artist: "Fictional artist",
          audioUrl: "https://media.example.test/c9.mp3",
          durationMs: 120000,
        },
      ],
    }),
    "GET /program/main/state": Response.json(programState("main", staged)),
    "GET /program/main/media-groups": Response.json([]),
    "GET /program/other/state": Response.json(programState("other")),
    "GET /program/other/media-groups": Response.json([]),
    "GET /media-assets?mediaType=AUDIO&capability=BACKGROUND&limit=200":
      Response.json({ data: [] }),
    "PUT /program/main/audio-bus": () => {
      const sent = server.calls.filter((call) => call.method === "PUT").at(-1)
        ?.body as { songSequence: unknown };
      return Response.json({ songSequence: sent.songSequence });
    },
    ...extra,
  });
  return render(view());
}

const view = () => (
  <MemoryRouter>
    <Control />
  </MemoryRouter>
);

const lastAudioBusPut = () =>
  server.requests("PUT /program/main/audio-bus").at(-1) as {
    songSequence: {
      mode: string;
      activeItemId: string | null;
      items: Array<{ id: string; title: string }>;
    };
  };

async function addCatalogSongFromSheet() {
  fireEvent.click(await screen.findByRole("button", { name: "Add songs" }));
  const sheet = await screen.findByRole("dialog");
  const saves = server.requests("PUT /program/main/audio-bus").length;
  fireEvent.click(
    within(sheet).getAllByRole("button", { name: /^Add .+ to the playlist$/ })[0],
  );
  await waitFor(() =>
    expect(server.requests("PUT /program/main/audio-bus").length).toBe(
      saves + 1,
    ),
  );
  return lastAudioBusPut().songSequence;
}

beforeEach(() => {
  deep.program = "main";
  deep.workspace = null;
  deep.unreadableTitle = null;
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  stubConsoleBrowser();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("takes the Preview to Program with the cut transition when CUT is pressed", async () => {
  open(
    { "POST /program/main/activate": Response.json(programState("main")) },
    headlines,
  );
  const cut = await screen.findByRole("button", { name: "CUT" });
  await waitFor(() => expect(cut).toBeEnabled());
  fireEvent.click(cut);
  await waitFor(() =>
    expect(server.requests("POST /program/main/activate")).toEqual([
      { sceneId: headlines.id, transitionId: "cut" },
    ]),
  );
});

it("closes the playlist sheet from its Close control", async () => {
  deep.workspace = "audio";
  open({
    "GET /program/main/audio-bus": Response.json({
      songSequence: null,
      songQueue: [],
    }),
  });
  fireEvent.click(await screen.findByRole("button", { name: "Add songs" }));
  const sheet = await screen.findByRole("dialog");
  fireEvent.click(within(sheet).getByRole("button", { name: "Close" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});

it("plays a stored rotation whose active item is a nested sequence from the first song inside it", async () => {
  deep.workspace = "audio";
  open({
    "GET /program/main/audio-bus": Response.json({
      songSequence: {
        mode: "manual",
        activeItemId: "nest",
        items: [
          {
            id: "nest",
            kind: "sequence",
            sequence: {
              mode: "manual",
              activeItemId: null,
              items: [
                song("s1", "Fictional nested opener"),
                song("s2", "Fictional nested closer"),
              ],
            },
          },
        ],
      },
      songQueue: [],
    }),
  });
  const saved = await addCatalogSongFromSheet();
  expect(saved.activeItemId).toBe("s1");
  expect(saved.items.map((item) => item.title)).toEqual([
    "Fictional nested opener",
    "Fictional nested closer",
    "Fictional catalog song",
  ]);
});

it("reads a stored song sequence it cannot normalise as an empty manual rotation", async () => {
  deep.workspace = "audio";
  deep.unreadableTitle = "Fictional unreadable song";
  open({
    "GET /program/main/audio-bus": Response.json({
      songSequence: {
        fixtureRaw: true,
        mode: "autoplay",
        activeItemId: "s1",
        items: [song("s1", "Fictional unreadable song")],
      },
      songQueue: [],
    }),
  });
  const saved = await addCatalogSongFromSheet();
  // The catalog song is added to an empty manual rotation, not to the stored song.
  expect(saved.mode).toBe("manual");
  expect(saved.items.map((item) => item.title)).toEqual([
    "Fictional catalog song",
  ]);
});

it("saves an edited song sequence it cannot normalise as an empty manual rotation", async () => {
  deep.workspace = "audio";
  deep.unreadableTitle = "Fictional catalog song";
  open({
    "GET /program/main/audio-bus": Response.json({
      songSequence: {
        mode: "manual",
        activeItemId: "s1",
        items: [song("s1", "Fictional stored song")],
      },
      songQueue: [],
    }),
  });
  const saved = await addCatalogSongFromSheet();
  expect(saved).toMatchObject({
    mode: "manual",
    activeItemId: null,
    items: [],
  });
});

it("changes nothing on screen when a Preview answer arrives after a switch to a program that has not loaded", async () => {
  let answerStage: (response: Response) => void = () => {};
  let answerOtherState: (response: Response) => void = () => {};
  const rendered = open({
    "POST /program/main/stage": () =>
      new Promise<Response>((resolve) => {
        answerStage = resolve;
      }),
    "GET /program/other/state": () =>
      new Promise<Response>((resolve) => {
        answerOtherState = resolve;
      }),
  });
  fireEvent.click(
    (await screen.findAllByRole("button", { name: /Fictional headlines/ }))[0],
  );
  await waitFor(() =>
    expect(server.requests("POST /program/main/stage")).toHaveLength(1),
  );

  deep.program = "other";
  rendered.rerender(view());
  await screen.findByText("Loading other control surface…");
  await act(async () => {
    answerStage(
      // An unversioned answer: a versioned one is recorded against the program now on screen
      // (gaulatti/alcantara#669), which this test does not cover.
      Response.json({ stagedSceneId: headlines.id, stagedScene: headlines }),
    );
  });
  // The answer found no program state to change: the new program is still loading.
  expect(screen.getByText("Loading other control surface…")).toBeVisible();

  await act(async () => {
    answerOtherState(Response.json(programState("other")));
  });
  await screen.findAllByRole("button", { name: /Fictional headlines/ });
  // The other program's own state, with nothing in Preview, is what is shown.
  expect(screen.queryByText("Preview")).toBeNull();
});

it("has no active song when the stored rotation's active item is a nested sequence with no songs", async () => {
  deep.workspace = "audio";
  open({
    "GET /program/main/audio-bus": Response.json({
      songSequence: {
        mode: "manual",
        activeItemId: "nest",
        items: [
          {
            id: "nest",
            kind: "sequence",
            sequence: { mode: "manual", activeItemId: null, items: [] },
          },
        ],
      },
      songQueue: [],
    }),
  });
  const saved = await addCatalogSongFromSheet();
  // The empty nested sequence plays nothing, so no song is active and it is not saved back.
  expect(saved.activeItemId).toBeNull();
  expect(saved.items.map((item) => item.title)).toEqual([
    "Fictional catalog song",
  ]);
});
