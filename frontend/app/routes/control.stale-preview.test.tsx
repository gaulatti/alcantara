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
  type Answer,
  type ControlServer,
} from "../../test/controlKit";

// gaulatti/alcantara#669: a Preview answer belongs to the program it was asked for. One that arrives after the
// operator switched program changes nothing on the program now on screen: it neither records its version against
// that program (which could refuse the program's own state and leave the console loading), nor selects its scene,
// nor writes its Preview, nor shows its failure there. The same holds for a fade-to-black answer.

const program = vi.hoisted(() => ({ id: "main" }));

vi.mock("../hooks/useSSE", () => ({ useSSE: () => ({ isConnected: true }) }));
vi.mock("../utils/globalProgram", () => ({
  useGlobalProgramId: () => [program.id],
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

const headlines = {
  id: 1,
  name: "Fictional headlines",
  layoutId: 1,
  metadata: {},
  layout: { id: 1, name: "Fixture layout", componentType: "toni-clock" },
};

const programState = (programId: string, version: number) => ({
  id: programId === "main" ? 1 : 2,
  programId,
  type: "tv",
  version,
  activeSceneId: null,
  stagedSceneId: null,
  stagedScene: null,
  fadeToBlack: false,
  scenes: [{ id: 1, sceneId: headlines.id, position: 0, scene: headlines }],
  mediaGroups: [],
});

const view = () => (
  <MemoryRouter>
    <Control />
  </MemoryRouter>
);

function open(extra: Record<string, Answer> = {}) {
  server = controlServer({
    "GET /scenes": Response.json([headlines]),
    "GET /instants": Response.json([]),
    "GET /songs?limit=0": Response.json({ data: [] }),
    "GET /program/main/state": Response.json(programState("main", 5)),
    "GET /program/main/media-groups": Response.json([]),
    "GET /program/other/state": Response.json(programState("other", 5)),
    "GET /program/other/media-groups": Response.json([]),
    "GET /media-assets?mediaType=AUDIO&capability=BACKGROUND&limit=200":
      Response.json({ data: [] }),
    ...extra,
  });
  return render(view());
}

// Stages the headlines on main with the answer held, then switches to the other program.
async function stageThenSwitch(rendered: ReturnType<typeof open>) {
  fireEvent.click(
    (await screen.findAllByRole("button", { name: /Fictional headlines/ }))[0],
  );
  await waitFor(() =>
    expect(server.requests("POST /program/main/stage")).toHaveLength(1),
  );
  program.id = "other";
  rendered.rerender(view());
}

const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });

beforeEach(() => {
  program.id = "main";
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  stubConsoleBrowser();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("loads the program switched to when a newer Preview answer for the program left arrives first", async () => {
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
  await stageThenSwitch(rendered);
  await screen.findByText("Loading other control surface…");
  const mainStateReads = server.requests("GET /program/main/state").length;

  // main's answer carries a version above the other program's own state.
  await act(async () => {
    answerStage(
      Response.json({
        stagedSceneId: headlines.id,
        stagedScene: headlines,
        version: 6,
      }),
    );
  });
  await act(async () => {
    answerOtherState(Response.json(programState("other", 5)));
  });

  // The other program loads, with nothing in Preview, and main's state is not read again for it.
  expect(
    await screen.findAllByRole("button", { name: /Fictional headlines/ }),
  ).not.toHaveLength(0);
  expect(screen.queryByText("Loading other control surface…")).toBeNull();
  expect(screen.queryByText("Preview")).toBeNull();
  expect(server.requests("GET /program/main/state")).toHaveLength(
    mainStateReads,
  );
});

it("leaves the loaded program's Preview alone when the answer for the program left arrives after it", async () => {
  let answerStage: (response: Response) => void = () => {};
  const rendered = open({
    "POST /program/main/stage": () =>
      new Promise<Response>((resolve) => {
        answerStage = resolve;
      }),
  });
  await stageThenSwitch(rendered);
  await screen.findAllByRole("button", { name: /Fictional headlines/ });
  await waitFor(() =>
    expect(server.requests("GET /program/other/state")).toHaveLength(1),
  );

  await act(async () => {
    answerStage(
      Response.json({
        stagedSceneId: headlines.id,
        stagedScene: headlines,
        version: 6,
      }),
    );
  });
  await settle();

  expect(screen.queryByText("Preview")).toBeNull();
  expect(screen.queryByRole("button", { name: "CUT" })).toBeDisabled();
});

it("shows no Preview failure on the program switched to", async () => {
  let failStage: (response: Response) => void = () => {};
  const rendered = open({
    "POST /program/main/stage": () =>
      new Promise<Response>((resolve) => {
        failStage = resolve;
      }),
  });
  await stageThenSwitch(rendered);
  await screen.findAllByRole("button", { name: /Fictional headlines/ });

  await act(async () => {
    failStage(new Response("down", { status: 503 }));
  });
  await settle();

  expect(screen.queryByText(/Could not prepare Preview/)).toBeNull();
});

it("still prepares the Preview for the program on screen", async () => {
  open({
    "POST /program/main/stage": Response.json({
      stagedSceneId: headlines.id,
      stagedScene: headlines,
      version: 6,
    }),
  });
  fireEvent.click(
    (await screen.findAllByRole("button", { name: /Fictional headlines/ }))[0],
  );
  expect(await screen.findByText("Preview")).toBeVisible();
  expect(screen.getByRole("button", { name: "CUT" })).toBeEnabled();
});

it("leaves the program switched to as it is when a fade answer for the program left arrives", async () => {
  let answerFade: (response: Response) => void = () => {};
  const rendered = open({
    "PUT /program/main/fade-to-black": () =>
      new Promise<Response>((resolve) => {
        answerFade = resolve;
      }),
  });
  fireEvent.click(await screen.findByRole("button", { name: "Fade to black" }));
  fireEvent.click(
    screen.getByRole("button", { name: /^Fade to black: armed/ }),
  );
  await waitFor(() =>
    expect(server.requests("PUT /program/main/fade-to-black")).toEqual([
      { active: true },
    ]),
  );
  program.id = "other";
  rendered.rerender(view());
  await screen.findAllByRole("button", { name: /Fictional headlines/ });

  await act(async () => {
    answerFade(
      Response.json({ ...programState("main", 6), fadeToBlack: true }),
    );
  });
  await settle();

  // The other program is not faded on screen: its own Fade to black is offered, not a restore.
  expect(screen.queryByRole("button", { name: "RESTORE PROGRAM" })).toBeNull();
  expect(screen.getByRole("button", { name: "Fade to black" })).toBeVisible();
});
