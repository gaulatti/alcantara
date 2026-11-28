import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  controlServer,
  stubConsoleBrowser,
  type ControlServer,
} from "../../test/controlKit";

// gaulatti/alcantara#682: radio desk audio-bus writes and a program switch. A playlist or mixer save answered after the operator moved to
// another program changes nothing on that program, and a fader move saves to the program it was made on.

vi.setConfig({ testTimeout: 30_000 });

const desk = vi.hoisted(() => ({
  program: "main",
  onMessage: null as null | ((data: unknown) => void),
}));

vi.mock("../hooks/useProgramEvents", () => ({
  useProgramEvents: (options: { onMessage?: (data: unknown) => void }) => {
    desk.onMessage = options.onMessage ?? null;
    return { isConnected: true };
  },
}));
vi.mock("../utils/globalProgram", () => ({
  useGlobalProgramId: () => [desk.program],
}));
vi.mock("../contexts/ConsolePreferencesContext", async (original) => {
  const actual =
    await original<typeof import("../contexts/ConsolePreferencesContext")>();
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

const song = (id: string, title: string) => ({
  id,
  kind: "preset",
  songId: Number(id.replace(/\D/g, "")),
  artist: "Fictional artist",
  title,
  coverUrl: "",
  audioUrl: `https://media.example.test/${id}.mp3`,
  durationMs: 180_000,
});

const programState = (programId: string) => ({
  id: programId === "main" ? 1 : 2,
  programId,
  type: "radio",
  activeSceneId: null,
  fadeToBlack: false,
  scenes: [],
  mediaGroups: [],
});

const audioBus = (programId: string, version: number, songVolume: number) => ({
  version,
  mixerSettings: { mainMasterVolume: 0.8, songMasterVolume: songVolume },
  songSequence: {
    mode: "manual",
    items:
      programId === "main"
        ? [song("m1", "Fictional main song")]
        : [song("o1", "Fictional other song")],
    activeItemId: null,
    intervalMs: 4000,
    loop: true,
    startedAt: 1,
  },
  songQueue: [],
});

const view = () => (
  <MemoryRouter>
    <Control />
  </MemoryRouter>
);

beforeEach(() => {
  desk.program = "main";
  desk.onMessage = null;
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  stubConsoleBrowser();
  server = controlServer({
    "GET /scenes": Response.json([]),
    "GET /instants": Response.json([]),
    "GET /songs?limit=0": Response.json({ data: [] }),
    "GET /program/main/control/state": Response.json(programState("main")),
    "GET /program/main/media-groups": Response.json([]),
    "GET /program/main/control/audio-bus": () =>
      Response.json(audioBus("main", 3, 0.6)),
    "GET /program/other/control/state": Response.json(programState("other")),
    "GET /program/other/media-groups": Response.json([]),
    "GET /program/other/control/audio-bus": () =>
      Response.json(audioBus("other", 3, 0.3)),
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const musicLevel = () =>
  screen.getByRole("slider", { name: "Music level" }) as HTMLInputElement;
const outputLevel = () =>
  screen.getByRole("slider", { name: "Output level" }) as HTMLInputElement;
const puts = (programId: string) =>
  server.requests(`PUT /program/${programId}/audio-bus`) as Array<{
    mixerSettings?: {
      mainMasterVolume: number;
      mixerChannels: Array<{ id: string; volume: number }>;
    };
    songSequence?: unknown;
  }>;

async function openMain() {
  const rendered = render(view());
  await screen.findAllByText("Fictional main song");
  await waitFor(() => expect(musicLevel().value).toBe("0.6"));
  return rendered;
}

async function switchToOther(rendered: ReturnType<typeof render>) {
  desk.program = "other";
  rendered.rerender(view());
  await screen.findAllByText("Fictional other song");
  await waitFor(() => expect(musicLevel().value).toBe("0.3"));
}

const held = () => {
  let answer: (response: Response) => void = () => {};
  const promise = () =>
    new Promise<Response>((resolve) => {
      answer = resolve;
    });
  return { promise, answer: (response: Response) => answer(response) };
};

it("keeps the other program's faders when a mixer save for the program left is answered after the switch", async () => {
  const save = held();
  server.answer("PUT /program/main/audio-bus", save.promise);
  const rendered = await openMain();
  fireEvent.change(musicLevel(), { target: { value: "0.5" } });
  await waitFor(() => expect(puts("main")).toHaveLength(1));

  await switchToOther(rendered);
  await act(async () => {
    save.answer(Response.json(audioBus("main", 4, 0.5)));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });

  expect(musicLevel().value).toBe("0.3");
});

it("saves a fader moved on the other program with that program's own levels after a late answer for the program left", async () => {
  const save = held();
  server.answer("PUT /program/main/audio-bus", save.promise);
  server.answer("PUT /program/other/audio-bus", () =>
    Response.json(audioBus("other", 4, 0.3)),
  );
  const rendered = await openMain();
  fireEvent.change(musicLevel(), { target: { value: "0.5" } });
  await waitFor(() => expect(puts("main")).toHaveLength(1));
  await switchToOther(rendered);
  await act(async () => {
    save.answer(Response.json(audioBus("main", 4, 0.5)));
  });

  fireEvent.change(outputLevel(), { target: { value: "0.7" } });
  await waitFor(() => expect(puts("other")).toHaveLength(1));
  const sent = puts("other")[0].mixerSettings!;
  expect(sent.mainMasterVolume).toBe(0.7);
  expect(
    sent.mixerChannels.find((channel) => channel.id === "song")?.volume,
  ).toBe(0.3);
});

it("saves a fader moved just before a switch to the program it was moved on, and leaves the other program's faders alone", async () => {
  server.answer("PUT /program/main/audio-bus", () =>
    Response.json(audioBus("main", 4, 0.5)),
  );
  const rendered = await openMain();
  // The move is saved after a short pause; the operator switches within it.
  fireEvent.change(musicLevel(), { target: { value: "0.5" } });
  desk.program = "other";
  rendered.rerender(view());
  await screen.findAllByText("Fictional other song");
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 400));
  });

  expect(puts("other")).toHaveLength(0);
  expect(
    puts("main")[0].mixerSettings!.mixerChannels.find(
      (channel) => channel.id === "song",
    )?.volume,
  ).toBe(0.5);
  expect(musicLevel().value).toBe("0.3");
});

it("applies the other program's own audio-bus update after a late answer for the program left", async () => {
  const save = held();
  server.answer("PUT /program/main/audio-bus", save.promise);
  const rendered = await openMain();
  fireEvent.change(musicLevel(), { target: { value: "0.5" } });
  await waitFor(() => expect(puts("main")).toHaveLength(1));
  await switchToOther(rendered);
  // The program left is further along: its answer carries a higher version than the other program's update.
  await act(async () => {
    save.answer(Response.json(audioBus("main", 9, 0.5)));
  });

  await act(async () => {
    desk.onMessage?.({
      type: "audio_bus_update",
      programId: "other",
      settings: audioBus("other", 4, 0.25),
    });
  });
  await waitFor(() => expect(musicLevel().value).toBe("0.25"));
});

it("keeps the other program's playlist when a playlist save for the program left is answered after the switch", async () => {
  const save = held();
  server.answer("PUT /program/main/audio-bus", save.promise);
  const rendered = await openMain();
  // Turning Loop off saves main's song sequence.
  fireEvent.click(screen.getByRole("button", { name: "Loop playlist: on" }));
  await waitFor(() => expect(puts("main")).toHaveLength(1));
  await switchToOther(rendered);

  const answered = audioBus("main", 4, 0.6);
  await act(async () => {
    save.answer(
      Response.json({
        ...answered,
        songSequence: { ...answered.songSequence, loop: false },
      }),
    );
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });

  expect(screen.getAllByText("Fictional other song").length).toBeGreaterThan(0);
  expect(screen.queryAllByText("Fictional main song")).toHaveLength(0);
  expect(
    screen.getByRole("button", { name: "Loop playlist: on" }),
  ).toBeVisible();
});

it("shows no mixer failure for the program left on the program switched to", async () => {
  const save = held();
  server.answer("PUT /program/main/audio-bus", save.promise);
  const rendered = await openMain();
  fireEvent.change(musicLevel(), { target: { value: "0.5" } });
  await waitFor(() => expect(puts("main")).toHaveLength(1));
  await switchToOther(rendered);
  await act(async () => {
    save.answer(new Response("down", { status: 503 }));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  expect(screen.queryByText(/Mixer change was not applied/)).toBeNull();
});

it("shows no playlist failure and reads nothing again for the program left when its save fails after the switch", async () => {
  const save = held();
  server.answer("PUT /program/main/audio-bus", save.promise);
  const rendered = await openMain();
  fireEvent.click(screen.getByRole("button", { name: "Loop playlist: on" }));
  await waitFor(() => expect(puts("main")).toHaveLength(1));
  await switchToOther(rendered);
  const mainReads = server.requests("GET /program/main/control/audio-bus").length;
  await act(async () => {
    save.answer(new Response("down", { status: 503 }));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  // No alert speaks for main's failed save.
  expect(
    screen
      .queryAllByRole("alert")
      .map((alert) => alert.textContent ?? "")
      .filter((text) => /Rotation was not changed|503|\bdown\b/.test(text)),
  ).toEqual([]);
  expect(server.requests("GET /program/main/control/audio-bus")).toHaveLength(
    mainReads,
  );
  expect(screen.getAllByText("Fictional other song").length).toBeGreaterThan(0);
});
