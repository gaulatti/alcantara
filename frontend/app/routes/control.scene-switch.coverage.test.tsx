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

// gaulatti/alcantara#404 (control.tsx remainder, scene switch with an unsaved edit): every edit saves at once, and the
// editor stays dirty only until that save lands. When the operator switches scenes while the save is still in flight,
// the previous scene's edit is queued again for that scene, so it is saved to scene 1 once the first save answers and
// never sent to the newly selected scene.

const sse = vi.hoisted(() => ({
  onMessage: null as null | ((data: unknown) => void),
}));
vi.mock("../hooks/useSSE", () => ({
  useSSE: (options: { onMessage?: (data: unknown) => void }) => {
    sse.onMessage = options.onMessage ?? null;
    return { isConnected: true };
  },
}));
vi.mock("../utils/globalProgram", () => ({
  useGlobalProgramId: () => ["main"],
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

// The design system's Select is a native select here, as in the bracket
// editor's own tests, so a ballot can be cast with a change event.
vi.mock("@gaulatti/bleecker", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@gaulatti/bleecker")>();
  return {
    ...actual,
    Select: ({ options, onChange, value, ...rest }: any) => (
      <select
        {...rest}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
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

const scene = (id: number, name: string) => ({
  id,
  name,
  layoutId: 1,
  metadata: JSON.stringify({ header: { show: false } }),
  layout: { id: 1, name: "Fixture layout", componentType: "header" },
});

const first = scene(1, "Fictional first scene");
const second = scene(2, "Fictional second scene");

function open() {
  server = controlServer({
    "GET /scenes": Response.json([first, second]),
    "GET /instants": Response.json([]),
    "GET /songs?limit=0": Response.json({ data: [] }),
    "GET /program/main/state": Response.json({
      id: 1,
      programId: "main",
      type: "tv",
      activeSceneId: null,
      stagedSceneId: 1,
      stagedScene: first,
      fadeToBlack: false,
      scenes: [
        { id: 1, sceneId: 1, position: 0, scene: first },
        { id: 2, sceneId: 2, position: 1, scene: second },
      ],
      mediaGroups: [],
    }),
    "GET /program/main/media-groups": Response.json([]),
    "GET /media-assets?mediaType=AUDIO&capability=BACKGROUND&limit=200":
      Response.json({ data: [] }),
  });
  render(
    <MemoryRouter>
      <Control />
    </MemoryRouter>,
  );
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

it("saves the previous scene's edit to that scene when the operator switches while its save is in flight", async () => {
  open();
  let answerFirstSave: (response: Response) => void = () => {};
  let saves = 0;
  server.answer("PUT /scenes/1", () => {
    saves += 1;
    if (saves === 1) {
      return new Promise<Response>((resolve) => {
        answerFirstSave = resolve;
      });
    }
    return Response.json(first);
  });
  server.answer("PUT /scenes/2", () => Response.json(second));

  fireEvent.click(
    await screen.findByRole("button", { name: "Show component" }),
  );
  await waitFor(() => expect(server.requests("PUT /scenes/1")).toHaveLength(1));
  const edit = server.requests("PUT /scenes/1")[0];

  // The switch arrives while scene 1's save is still unanswered, before the editor's autosave pause ends.
  act(() =>
    sse.onMessage?.({
      type: "scene_staged",
      programId: "main",
      stagedSceneId: 2,
      scene: second,
    }),
  );
  await act(async () => {
    answerFirstSave(Response.json(first));
  });

  await waitFor(() => expect(server.requests("PUT /scenes/1")).toHaveLength(2));
  expect(server.requests("PUT /scenes/1")[1]).toEqual(edit);
  expect(server.requests("PUT /scenes/2")).toHaveLength(0);
});
