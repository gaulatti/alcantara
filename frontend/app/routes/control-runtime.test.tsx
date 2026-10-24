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
import { Provider } from "react-redux";
import { legacy_createStore } from "redux";
import { MemoryRouter } from "react-router";
import { ConsolePreferencesProvider } from "../contexts/ConsolePreferencesContext";
import { FeaturesProvider } from "../hooks/useFeatures";
import { reducers } from "../state/reducers";
import { api } from "../services/api";
import Control from "./control";
import type { ProgramSongSequence } from "../utils/programSequence";
import type {
  BackgroundAudioAsset,
  Scene,
  ProgramState,
  RecordingStatus,
} from "../models/broadcast";

// Authentication and browser transports are external boundaries; the route,
// reducers, preferences, SSE hook and all rendered children remain real.
vi.mock("../services/session", () => ({
  getAppSession: async () => ({
    token: "fixture-session",
    userSub: "operator-a",
  }),
}));
vi.mock("../utils/apiBaseUrl", () => ({
  getApiBaseUrl: () => "https://control.example",
  apiUrl: (path: string) =>
    path.startsWith("https:") ? path : `https://control.example${path}`,
}));
class FixtureEventSource {
  static instances: FixtureEventSource[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  close = vi.fn();
  constructor(readonly url: string) {
    FixtureEventSource.instances.push(this);
  }
  emit(data: unknown) {
    act(() => this.onmessage?.({ data: JSON.stringify(data) }));
  }
}
class FixtureWebSocket extends EventTarget {
  static OPEN = 1;
  static instances: FixtureWebSocket[] = [];
  readyState = 0;
  close = vi.fn(() => {
    this.readyState = 3;
  });
  constructor(readonly url: string) {
    super();
    FixtureWebSocket.instances.push(this);
  }
  open() {
    this.readyState = 1;
    act(() => this.dispatchEvent(new Event("open")));
  }
  emit(data: unknown) {
    act(() =>
      this.dispatchEvent(
        new MessageEvent("message", { data: JSON.stringify(data) }),
      ),
    );
  }
}
const layout = { id: 1, name: "Clean", componentType: "", settings: "{}" };
const makeScene = (id: number, name: string): Scene => ({
  id,
  name,
  layoutId: 1,
  layout,
  metadata: "{}",
  chyronText: null,
});
let scenes: Scene[];
let state: ProgramState & { version: number };
let requests: { method: string; path: string; body: any; headers: Headers }[];
let failures: Record<string, number>;
let unexpected: string[];
let instants: {
  id: number;
  name: string;
  audioUrl: string;
  enabled: boolean;
  position: number;
  volume: number;
}[];
let mixer: any;
let assets: BackgroundAudioAsset[];
let recording: RecordingStatus;
let songSequence: ProgramSongSequence;
const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
const profile = {
  workspace: "director",
  dockWidth: 320,
  touchMode: false,
  shortcutsEnabled: true,
  selectedProgramId: "main",
  transitions: { main: "cut" },
};
async function transport(input: RequestInfo | URL, init?: RequestInit) {
  const url = new URL(String(input));
  const path = url.pathname + url.search;
  const method = init?.method ?? "GET";
  const body = init?.body ? JSON.parse(String(init.body)) : null;
  requests.push({ method, path, body, headers: new Headers(init?.headers) });
  if (failures[`${method} ${url.pathname}`])
    return response(
      { message: "Fixture rejected action" },
      failures[`${method} ${url.pathname}`],
    );
  if (url.pathname === "/operator-preferences/desktop")
    return response({ version: 1, profile: body?.profile ?? profile });
  if (path === "/scenes") return response(scenes);
  if (path === "/layouts") return response([layout]);
  if (path === "/instants") return response(instants);
  if (path === "/songs?limit=0" || path === "/program/main/media-groups")
    return response([]);
  if (url.pathname === "/media-labels")
    return response({ data: [], meta: { totalPages: 0 } });
  if (url.pathname === "/media-assets") return response({ data: assets });
  if (path === "/auth/realtime-ticket")
    return response({ ticket: "fixture-ticket" });
  if (path === "/program/main/recording") return response(recording);
  if (method === "POST" && path.startsWith("/program/main/recording/")) {
    recording = {
      ...recording,
      state: path.endsWith("/start") ? "active" : "finalizing",
    };
    return response(recording);
  }
  if (method === "POST" && path === "/program/main/scene-instant/take")
    return response({
      ...body,
      mediaAssetId: body.mediaAssetId,
      isPlaying: true,
      instant: { id: null, name: "Bed music" },
    });
  if (method === "POST" && path === "/program/main/scene-instant/stop")
    return response({ sceneId: 2, isPlaying: false });
  if (path === "/program/main/state") return response(state);
  if (path === "/program/main/audio-bus") {
    if (body?.songSequence) songSequence = body.songSequence;
    return response({
      songSequence,
      songQueue: [],
      mixerSettings:
        method === "PUT" ? (mixer = body.mixerSettings ?? mixer) : mixer,
    });
  }
  if (
    path === "/program/main/audio-meter" ||
    path === "/program/main/song-playback" ||
    path === "/program/main/scene-instant"
  )
    return response({});
  if (method === "POST" && path === "/program/main/stage") {
    state = {
      ...state,
      stagedSceneId: body.sceneId,
      stagedScene: scenes.find((s) => s.id === body.sceneId) ?? null,
      version: state.version + 1,
    };
    return response(state);
  }
  if (method === "POST" && path === "/program/main/activate") {
    state = {
      ...state,
      activeSceneId: body.sceneId,
      activeScene: scenes.find((s) => s.id === body.sceneId),
      stagedSceneId: state.activeSceneId,
      stagedScene: state.activeScene,
      version: state.version + 1,
    };
    return response(state);
  }
  if (method === "PUT" && path === "/program/main/fade-to-black") {
    state = { ...state, fadeToBlack: body.active, version: state.version + 1 };
    return response(state);
  }
  if (
    method === "POST" &&
    (url.pathname === "/instants/stop-all" ||
      /^\/instants\/\d+\/play$/.test(url.pathname))
  )
    return response({});
  if (
    method === "POST" &&
    (path === "/radio/main/song" || path === "/program/main/song/off-air")
  )
    return response({});
  unexpected.push(`${method} ${path}`);
  return response({ message: "Unexpected fixture request" }, 500);
}
beforeEach(() => {
  scenes = [
    makeScene(1, "Opening camera"),
    makeScene(2, "Interview camera"),
    makeScene(3, "Closing camera"),
  ];
  state = {
    id: 1,
    programId: "main",
    type: "tv",
    activeSceneId: 1,
    activeScene: scenes[0],
    stagedSceneId: 2,
    stagedScene: scenes[1],
    fadeToBlack: false,
    scenes: scenes.map((scene, position) => ({
      id: scene.id,
      sceneId: scene.id,
      position,
      scene,
    })),
    mediaGroups: [],
    version: 10,
  };
  instants = [];
  mixer = {};
  assets = [];
  songSequence = { mode: "manual", items: [], activeItemId: null };
  recording = {
    enabled: true,
    state: "idle",
    requestedAt: null,
    startedAt: null,
    stoppedAt: null,
    finalizedAt: null,
    updatedAt: null,
    segmentCount: 0,
    bytes: 0,
    durationSeconds: 0,
    droppedFrames: 0,
    errors: 0,
    restarts: 0,
    finalizationState: "not-requested",
    finalBytes: 0,
    error: null,
    disk: null,
  };
  requests = [];
  failures = {};
  unexpected = [];
  FixtureEventSource.instances = [];
  localStorage.clear();
  vi.stubGlobal("innerWidth", 1600);
  vi.stubGlobal("fetch", vi.fn(transport));
  vi.stubGlobal("EventSource", FixtureEventSource);
  FixtureWebSocket.instances = [];
  vi.stubGlobal("WebSocket", FixtureWebSocket);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
  api.defaults.adapter = async (config) => {
    if (config.url !== "/auth/me")
      throw new Error(`Unexpected Axios route: ${config.url}`);
    return {
      config,
      data: { authorization: { permissions: ["*"] } },
      status: 200,
      statusText: "OK",
      headers: {},
    };
  };
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
  const result = render(
    <Provider store={store}>
      <MemoryRouter>
        <FeaturesProvider>
          <ConsolePreferencesProvider>
            <Control />
          </ConsolePreferencesProvider>
        </FeaturesProvider>
      </MemoryRouter>
    </Provider>,
  );
  await screen.findByRole("textbox", { name: "Search scenes" });
  await waitFor(() =>
    expect(screen.getByText("Ready: Interview camera")).toBeInTheDocument(),
  );
  return result;
}
const calls = (path: string) =>
  requests.filter(
    (request) => request.path === path && request.method !== "GET",
  );
it("loads real assigned scenes and authenticates the media catalogue", async () => {
  await mount();
  expect(
    within(screen.getByLabelText("Assigned scenes")).getAllByRole("button"),
  ).toHaveLength(3);
  expect(screen.getByTitle("PROGRAM confidence monitor")).toHaveAttribute(
    "src",
    expect.stringContaining("main"),
  );
  expect(
    requests
      .find((r) => r.path.startsWith("/media-assets"))
      ?.headers.get("Authorization"),
  ).toBe("Bearer fixture-session");
});
it("stages a filtered source without changing Program", async () => {
  await mount();
  fireEvent.change(screen.getByRole("textbox", { name: "Search scenes" }), {
    target: { value: "Closing" },
  });
  fireEvent.click(screen.getByRole("button", { name: /Closing camera/ }));
  await screen.findByText("Ready: Closing camera");
  expect(calls("/program/main/stage")[0].body).toEqual({ sceneId: 3 });
  expect(state.activeSceneId).toBe(1);
  expect(calls("/program/main/activate")).toHaveLength(0);
});
it.each(["TAKE TO PROGRAM", "CUT"])(
  "%s activates the prepared source and moves previous Program to Preview",
  async (action) => {
    await mount();
    fireEvent.click(screen.getByRole("button", { name: action }));
    await screen.findByText("Ready: Opening camera");
    expect(calls("/program/main/activate")).toHaveLength(1);
    expect(calls("/program/main/activate")[0].body).toEqual({
      sceneId: 2,
      transitionId: "cut",
    });
    expect(state.activeSceneId).toBe(2);
  },
);
it("uses the selected transition for TAKE while CUT stays immediate", async () => {
  await mount();
  const transition = screen.getByRole("combobox", { name: "Transition" });
  const alternative = Array.from(
    (transition as HTMLSelectElement).options,
  ).find((option) => option.value !== "cut")!;
  fireEvent.change(transition, { target: { value: alternative.value } });
  fireEvent.click(screen.getByRole("button", { name: "TAKE TO PROGRAM" }));
  await waitFor(() => expect(calls("/program/main/activate")).toHaveLength(1));
  expect(calls("/program/main/activate")[0].body.transitionId).toBe(
    alternative.value,
  );
});
it("keeps the live scene when staging fails and blocks a subsequent TAKE", async () => {
  await mount();
  failures["POST /program/main/stage"] = 403;
  fireEvent.click(screen.getByRole("button", { name: /Closing camera/ }));
  await screen.findByText("Could not prepare Preview: HTTP 403");
  fireEvent.click(screen.getByRole("button", { name: "TAKE TO PROGRAM" }));
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(calls("/program/main/activate")).toHaveLength(0);
  expect(state.activeSceneId).toBe(1);
});
it("surfaces an activation rejection and retains the prepared source", async () => {
  await mount();
  failures["POST /program/main/activate"] = 409;
  fireEvent.click(screen.getByRole("button", { name: "TAKE TO PROGRAM" }));
  await screen.findByText("Fixture rejected action");
  expect(state.activeSceneId).toBe(1);
  expect(screen.getByText("Ready: Interview camera")).toBeInTheDocument();
});
it("requires arming before fade and restores Program with a separate command", async () => {
  await mount();
  fireEvent.click(screen.getByRole("button", { name: "ARM FADE TO BLACK" }));
  expect(calls("/program/main/fade-to-black")).toHaveLength(0);
  fireEvent.click(
    screen.getByRole("button", { name: "CONFIRM FADE TO BLACK" }),
  );
  await screen.findByRole("button", { name: "RESTORE PROGRAM" });
  expect(calls("/program/main/fade-to-black")[0].body).toEqual({
    active: true,
  });
  fireEvent.click(screen.getByRole("button", { name: "RESTORE PROGRAM" }));
  await screen.findByRole("button", { name: "ARM FADE TO BLACK" });
  expect(calls("/program/main/fade-to-black")[1].body).toEqual({
    active: false,
  });
});
it("clears Preview using the keyboard and disables both transitions", async () => {
  await mount();
  fireEvent.keyDown(window, { key: "Escape" });
  await screen.findByText("Choose a source to prepare the next scene.");
  expect(calls("/program/main/stage")[0].body).toEqual({ sceneId: null });
  expect(
    screen.getByRole("button", { name: "TAKE TO PROGRAM" }),
  ).toBeDisabled();
  expect(screen.getByRole("button", { name: "CUT" })).toBeDisabled();
});
it("only enables numbered scene hotkeys after the explicit chord", async () => {
  await mount();
  fireEvent.keyDown(window, { key: "3", code: "Digit3", ctrlKey: true });
  expect(calls("/program/main/stage")).toHaveLength(0);
  fireEvent.keyDown(window, { key: "s", code: "KeyS", ctrlKey: true });
  fireEvent.keyDown(window, { key: "3", code: "Digit3", ctrlKey: true });
  await screen.findByText("Ready: Closing camera");
  expect(calls("/program/main/stage")[0].body).toEqual({ sceneId: 3 });
});
it("does not perform a broadcast shortcut while typing in a search field", async () => {
  await mount();
  fireEvent.keyDown(screen.getByRole("textbox", { name: "Search scenes" }), {
    key: "c",
  });
  expect(calls("/program/main/activate")).toHaveLength(0);
});
it("takes the source with the Space shortcut", async () => {
  await mount();
  fireEvent.keyDown(window, { key: " ", code: "Space" });
  await screen.findByText("Ready: Opening camera");
  expect(state.activeSceneId).toBe(2);
});
it.each([
  "program_state_snapshot",
  "scene_change",
  "program_scenes_changed",
  "fade_to_black",
])("applies a fresh %s over the actual event stream", async (type) => {
  await mount();
  FixtureEventSource.instances[0].emit({
    type,
    programId: "main",
    version: 11,
    state: { ...state, stagedSceneId: 3, stagedScene: scenes[2] },
  });
  await screen.findByText("Ready: Closing camera");
  expect(calls("/program/main/stage")).toHaveLength(0);
});
it("rejects stale and cross-program snapshots without losing current Preview", async () => {
  await mount();
  const stream = FixtureEventSource.instances[0];
  stream.emit({
    type: "program_state_snapshot",
    programId: "main",
    version: 11,
    state: { ...state, stagedSceneId: 3, stagedScene: scenes[2] },
  });
  await screen.findByText("Ready: Closing camera");
  stream.emit({
    type: "program_state_snapshot",
    programId: "main",
    version: 10,
    state,
  });
  stream.emit({
    type: "program_state_snapshot",
    programId: "other",
    version: 12,
    state,
  });
  stream.emit(null);
  expect(screen.getByText("Ready: Closing camera")).toBeInTheDocument();
});
it("accepts staged events and clears Preview when the server removes it", async () => {
  await mount();
  const stream = FixtureEventSource.instances[0];
  stream.emit({
    type: "scene_staged",
    programId: "main",
    version: 11,
    stagedSceneId: 3,
    scene: scenes[2],
  });
  await screen.findByText("Ready: Closing camera");
  stream.emit({
    type: "scene_staged",
    programId: "main",
    version: 12,
    stagedSceneId: null,
    scene: null,
  });
  await screen.findByText("Choose a source to prepare the next scene.");
});
it("updates source names from server scene edits", async () => {
  await mount();
  FixtureEventSource.instances[0].emit({
    type: "scene_update",
    programId: "main",
    scene: { ...scenes[1], name: "Interview revised" },
  });
  await screen.findByText("Ready: Interview revised");
  expect(
    screen.getByRole("button", { name: /Interview revised/ }),
  ).toBeInTheDocument();
});
it("closes its stream when the operator leaves the screen", async () => {
  const view = await mount();
  const stream = FixtureEventSource.instances[0];
  act(() => stream.onopen?.());
  view.unmount();
  expect(stream.close).toHaveBeenCalledOnce();
});
async function openAudio() {
  await mount();
  fireEvent.click(screen.getByRole("button", { name: "Audio" }));
  await screen.findByRole("region", { name: "Audio mixer" });
}
it("switches to the real audio workspace and returns to the director surface", async () => {
  await openAudio();
  expect(screen.getByRole("region", { name: "Cartwall" })).toBeInTheDocument();
  expect(screen.queryByLabelText("Assigned scenes")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Director" }));
  expect(screen.getByLabelText("Assigned scenes")).toBeInTheDocument();
  expect(screen.getByText("Ready: Interview camera")).toBeInTheDocument();
});
it.each(["Music", "Stream", "Cartwall", "Scene audio"])(
  "persists the %s mute through the real mixer",
  async (channel) => {
    if (channel === "Stream")
      scenes[0].layout = { ...layout, componentType: "video-stream" };
    await openAudio();
    fireEvent.click(screen.getByRole("button", { name: `Mute ${channel}` }));
    await waitFor(() =>
      expect(calls("/program/main/audio-bus")).toHaveLength(1),
    );
    const expectedId = {
      Music: "song",
      Stream: "stream",
      Cartwall: "instants",
      "Scene audio": "sceneInstant",
    }[channel];
    expect(
      calls("/program/main/audio-bus")[0].body.mixerSettings.mixerChannels.find(
        (value: any) => value.id === expectedId,
      ).muted,
    ).toBe(true);
    expect(
      screen.getByRole("button", { name: `Mute ${channel}` }),
    ).toHaveAttribute("aria-pressed", "true");
  },
);
it("persists main output fader changes independently of channel mute", async () => {
  await openAudio();
  fireEvent.change(screen.getByRole("slider", { name: "Main mix fader" }), {
    target: { value: "0.4" },
  });
  await waitFor(() => expect(calls("/program/main/audio-bus")).toHaveLength(1));
  expect(
    calls("/program/main/audio-bus")[0].body.mixerSettings.mainMasterVolume,
  ).toBe(0.4);
});
it("reports a rejected mixer write without claiming the level was applied", async () => {
  await openAudio();
  failures["PUT /program/main/audio-bus"] = 503;
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  fireEvent.click(screen.getByRole("button", { name: "Mute Music" }));
  await screen.findByText(
    "Mixer change was not applied to Palazzo. Try again.",
  );
  expect(errors).toHaveBeenCalledWith(
    "Failed to save mixer levels:",
    expect.any(Error),
  );
});
it("reflects live mixer updates without writing them back", async () => {
  await openAudio();
  FixtureEventSource.instances[0].emit({
    type: "audio_bus_update",
    programId: "main",
    version: 1,
    settings: { mixerSettings: { songMuted: true, mainMasterVolume: 0.2 } },
  });
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Mute Music" })).toHaveAttribute(
      "aria-pressed",
      "true",
    ),
  );
  expect(screen.getByRole("slider", { name: "Main mix fader" })).toHaveValue(
    "0.2",
  );
  expect(calls("/program/main/audio-bus")).toHaveLength(0);
});
it("plays a cartwall clip and stops all clips without touching Program", async () => {
  instants = [
    {
      id: 8,
      name: "News sting",
      audioUrl: "",
      enabled: true,
      position: 0,
      volume: 1,
    },
  ];
  await openAudio();
  fireEvent.click(screen.getByRole("button", { name: "News sting" }));
  await screen.findByRole("button", { name: "News sting · playing" });
  expect(calls("/instants/8/play?programId=main")).toHaveLength(1);
  fireEvent.click(
    within(screen.getByRole("region", { name: "Cartwall" })).getByRole(
      "button",
      { name: "Stop all" },
    ),
  );
  await screen.findByRole("button", { name: "News sting" });
  expect(calls("/instants/stop-all?programId=main")).toHaveLength(1);
  expect(state.activeSceneId).toBe(1);
});
it("filters the cartwall and prevents disabled clips from playing", async () => {
  instants = [
    {
      id: 8,
      name: "News sting",
      audioUrl: "",
      enabled: true,
      position: 0,
      volume: 1,
    },
    {
      id: 9,
      name: "Unavailable sting",
      audioUrl: "",
      enabled: false,
      position: 1,
      volume: 1,
    },
  ];
  await openAudio();
  expect(
    screen.getByRole("button", { name: "Unavailable sting" }),
  ).toBeDisabled();
  fireEvent.change(screen.getByRole("textbox", { name: "Search cartwall" }), {
    target: { value: "missing" },
  });
  expect(screen.getByText(/No instants match/)).toHaveTextContent("missing");
  expect(calls("/instants/9/play?programId=main")).toHaveLength(0);
});
it("triggers an enabled cartwall clip from its actual keyboard shortcut", async () => {
  instants = [
    {
      id: 8,
      name: "News sting",
      audioUrl: "",
      enabled: true,
      position: 0,
      volume: 1,
    },
  ];
  await openAudio();
  fireEvent.keyDown(window, { key: "q", code: "KeyQ", ctrlKey: true });
  await screen.findByRole("button", { name: "News sting · playing" });
  expect(calls("/instants/8/play?programId=main")).toHaveLength(1);
});
it.each(["Music", "Cartwall", "Scene audio"])(
  "persists independent %s solo selection",
  async (channel) => {
    await openAudio();
    fireEvent.click(screen.getByRole("button", { name: `Solo ${channel}` }));
    await waitFor(() =>
      expect(calls("/program/main/audio-bus")).toHaveLength(1),
    );
    const expectedId = {
      Music: "song",
      Cartwall: "instants",
      "Scene audio": "sceneInstant",
    }[channel];
    const channels = calls("/program/main/audio-bus")[0].body.mixerSettings
      .mixerChannels;
    expect(channels.find((value: any) => value.id === expectedId).solo).toBe(
      true,
    );
    expect(channels.filter((value: any) => value.solo)).toHaveLength(1);
  },
);
it.each(["Music", "Cartwall", "Scene audio"])(
  "writes %s fader changes into its own channel",
  async (channel) => {
    await openAudio();
    fireEvent.change(screen.getByRole("slider", { name: `${channel} fader` }), {
      target: { value: "0.35" },
    });
    await waitFor(() =>
      expect(calls("/program/main/audio-bus")).toHaveLength(1),
    );
    const expectedId = {
      Music: "song",
      Cartwall: "instants",
      "Scene audio": "sceneInstant",
    }[channel];
    expect(
      calls("/program/main/audio-bus")[0].body.mixerSettings.mixerChannels.find(
        (value: any) => value.id === expectedId,
      ).volume,
    ).toBe(0.35);
  },
);
it("ignores an older mixer snapshot after accepting a newer version", async () => {
  await openAudio();
  const stream = FixtureEventSource.instances[0];
  stream.emit({
    type: "audio_bus_update",
    programId: "main",
    version: 5,
    settings: { mixerSettings: { songMuted: true } },
  });
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Mute Music" })).toHaveAttribute(
      "aria-pressed",
      "true",
    ),
  );
  stream.emit({
    type: "audio_bus_update",
    programId: "main",
    version: 4,
    settings: { mixerSettings: { songMuted: false } },
  });
  expect(screen.getByRole("button", { name: "Mute Music" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
});
it("keeps a clip idle when the engine rejects its play request", async () => {
  instants = [
    {
      id: 8,
      name: "News sting",
      audioUrl: "",
      enabled: true,
      position: 0,
      volume: 1,
    },
  ];
  await openAudio();
  failures["POST /instants/8/play"] = 503;
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  fireEvent.click(screen.getByRole("button", { name: "News sting" }));
  await waitFor(() =>
    expect(errors).toHaveBeenCalledWith(
      "Failed to trigger instant:",
      expect.any(Error),
    ),
  );
  expect(screen.getByRole("button", { name: "News sting" })).toHaveAttribute(
    "data-playing",
    "false",
  );
});
it("keeps the playing indication when a stop-all command fails", async () => {
  instants = [
    {
      id: 8,
      name: "News sting",
      audioUrl: "",
      enabled: true,
      position: 0,
      volume: 1,
    },
  ];
  await openAudio();
  fireEvent.click(screen.getByRole("button", { name: "News sting" }));
  await screen.findByRole("button", { name: "News sting · playing" });
  failures["POST /instants/stop-all"] = 503;
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  fireEvent.click(
    within(screen.getByRole("region", { name: "Cartwall" })).getByRole(
      "button",
      { name: "Stop all" },
    ),
  );
  await waitFor(() =>
    expect(errors).toHaveBeenCalledWith(
      "Failed to stop all instants:",
      expect.any(Error),
    ),
  );
  expect(
    screen.getByRole("button", { name: "News sting · playing" }),
  ).toHaveAttribute("data-playing", "true");
});
async function openFallback() {
  const view = await mount();
  act(() => FixtureEventSource.instances[0].onerror?.());
  await waitFor(() => expect(FixtureWebSocket.instances).toHaveLength(1));
  const socket = FixtureWebSocket.instances[0];
  socket.open();
  return { view, socket };
}
it("requests an authenticated short-lived fallback ticket after SSE failure", async () => {
  const { socket } = await openFallback();
  const ticket = calls("/auth/realtime-ticket")[0];
  expect(ticket.body).toEqual({ programId: "main" });
  expect(ticket.headers.get("Authorization")).toBe("Bearer fixture-session");
  expect(socket.url).toBe(
    "wss://control.example/program/ws?programId=main&role=control&ticket=fixture-ticket",
  );
});
it.each(["program_state_snapshot", "scene_change", "program_scenes_changed"])(
  "recovers %s over the WebSocket fallback",
  async (type) => {
    const { socket } = await openFallback();
    socket.emit({
      type,
      programId: "main",
      version: 11,
      state: { ...state, stagedSceneId: 3, stagedScene: scenes[2] },
    });
    await screen.findByText("Ready: Closing camera");
  },
);
it("applies fallback staging and scene edits through the same real screen", async () => {
  const { socket } = await openFallback();
  socket.emit({
    type: "scene_staged",
    programId: "main",
    version: 11,
    stagedSceneId: 3,
    scene: scenes[2],
  });
  await screen.findByText("Ready: Closing camera");
  socket.emit({
    type: "scene_update",
    programId: "main",
    scene: { ...scenes[2], name: "Closing revised" },
  });
  await screen.findByText("Ready: Closing revised");
});
it("ignores malformed fallback messages and foreign source updates", async () => {
  const { socket } = await openFallback();
  act(() =>
    socket.dispatchEvent(new MessageEvent("message", { data: "{broken" })),
  );
  socket.emit(null);
  socket.emit({
    type: "scene_update",
    programId: "other",
    scene: { ...scenes[1], name: "Foreign scene" },
  });
  expect(screen.getByText("Ready: Interview camera")).toBeInTheDocument();
  expect(screen.queryByText("Foreign scene")).not.toBeInTheDocument();
});
it("closes the active fallback socket on departure", async () => {
  const { view, socket } = await openFallback();
  view.unmount();
  expect(socket.close).toHaveBeenCalledOnce();
});
it("discards the fallback transport when SSE reconnects", async () => {
  const { socket } = await openFallback();
  act(() => FixtureEventSource.instances[0].onopen?.());
  await waitFor(() => expect(socket.close).toHaveBeenCalled());
  expect(calls("/auth/realtime-ticket")).toHaveLength(1);
});
it("mounts recording only after its disclosure opens and keeps commands authenticated", async () => {
  await mount();
  expect(requests.some((r) => r.path === "/program/main/recording")).toBe(
    false,
  );
  const details = screen.getByText("Program recording", { selector: "summary" })
    .parentElement as HTMLDetailsElement;
  details.open = true;
  fireEvent(details, new Event("toggle"));
  await screen.findByText("Ready to record");
  fireEvent.click(screen.getByRole("button", { name: "Start recording" }));
  await screen.findByText("Recording active");
  const start = calls("/program/main/recording/start")[0];
  expect(start.headers.get("Authorization")).toBe("Bearer fixture-session");
  expect(start.headers.get("Idempotency-Key")).toMatch(
    /^alcantara-recording-start-/,
  );
  vi.spyOn(window, "confirm").mockReturnValue(true);
  fireEvent.click(screen.getByRole("button", { name: "Stop and finalize" }));
  await screen.findByText("Finalizing — media is not safe yet");
  expect(calls("/program/main/recording/stop")).toHaveLength(1);
  expect(state.activeSceneId).toBe(1);
});
it("renders a persisted background audio choice and operates it independently", async () => {
  assets = [
    {
      id: "bed-a",
      name: "Bed music",
      enabled: true,
      sourceUrl: "https://media.example/bed.mp3",
      background: { defaultVolume: 1 },
      instant: null,
    },
  ];
  scenes[1].metadata = JSON.stringify({ sceneInstant: { assetId: "bed-a" } });
  await mount();
  await screen.findByText("Ready: Bed music");
  fireEvent.click(screen.getByRole("button", { name: "TAKE BG" }));
  await screen.findByText("Playing: Bed music");
  expect(calls("/program/main/scene-instant/take")[0].body).toEqual({
    sceneId: 2,
    instantId: null,
    mediaAssetId: "bed-a",
  });
  fireEvent.click(screen.getByRole("button", { name: "STOP BG" }));
  await screen.findByText("Ready: Bed music");
  expect(calls("/program/main/scene-instant/stop")).toHaveLength(1);
  expect(calls("/program/main/activate")).toHaveLength(0);
});
const musicItem = (id: string, title: string) => ({
  id,
  kind: "preset" as const,
  artist: "Studio artist",
  title,
  coverUrl: "",
  audioUrl: `https://media.example/${id}.mp3`,
  durationMs: 120000,
  songId: Number(id.slice(-1)),
});
function loadPlaylist(mode: "manual" | "autoplay" = "manual") {
  songSequence = {
    mode,
    items: [
      musicItem("song-1", "First song"),
      musicItem("song-2", "Second song"),
    ],
    activeItemId: "song-1",
    loop: false,
  };
}
it("takes a manually selected song once after saving the selected sequence", async () => {
  loadPlaylist();
  await openAudio();
  fireEvent.click(screen.getByRole("button", { name: "Play selection" }));
  await waitFor(() => expect(calls("/radio/main/song")).toHaveLength(1));
  expect(
    calls("/program/main/audio-bus")[0].body.songSequence.activeItemId,
  ).toBe("song-1");
  expect(calls("/radio/main/song")[0].body).toEqual({
    audioUrl: "https://media.example/song-1.mp3",
    title: "First song",
    artist: "Studio artist",
    coverUrl: "",
    durationMs: 120000,
    songId: 1,
  });
  expect(
    requests.findIndex(
      (r) => r.method === "PUT" && r.path === "/program/main/audio-bus",
    ),
  ).toBeLessThan(requests.findIndex((r) => r.path === "/radio/main/song"));
});
it("starts idle automatic playback through persistence without a duplicate manual take", async () => {
  loadPlaylist("autoplay");
  await openAudio();
  fireEvent.click(screen.getByRole("button", { name: "Play selection" }));
  await waitFor(() => expect(calls("/program/main/audio-bus")).toHaveLength(1));
  expect(calls("/program/main/audio-bus")[0].body.songSequence.mode).toBe(
    "autoplay",
  );
  expect(calls("/radio/main/song")).toHaveLength(0);
});
it("advances to the next song through the actual transport", async () => {
  loadPlaylist();
  await openAudio();
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  await waitFor(() => expect(calls("/radio/main/song")).toHaveLength(1));
  expect(calls("/radio/main/song")[0].body.title).toBe("Second song");
  expect(songSequence.activeItemId).toBe("song-2");
});
it("takes music off air without clearing the saved playlist or the video scene", async () => {
  loadPlaylist();
  await openAudio();
  const output = vi.spyOn(console, "log").mockImplementation(() => {});
  fireEvent.click(screen.getByRole("button", { name: "Stop / Take Off Air" }));
  await waitFor(() =>
    expect(calls("/program/main/song/off-air")).toHaveLength(1),
  );
  expect(songSequence.items).toHaveLength(2);
  expect(calls("/program/main/audio-bus")).toHaveLength(0);
  expect(state.activeSceneId).toBe(1);
  expect(output).toHaveBeenCalledWith(
    "[Control] takeProgramSongOffAir response 200",
  );
});
it("saves playback mode and loop independently through the real transport", async () => {
  loadPlaylist();
  await openAudio();
  fireEvent.click(
    within(screen.getByRole("group", { name: "Playback mode" })).getByRole(
      "button",
      { name: "Autoplay" },
    ),
  );
  await waitFor(() => expect(calls("/program/main/audio-bus")).toHaveLength(1));
  expect(songSequence.mode).toBe("autoplay");
  fireEvent.click(screen.getByRole("button", { name: "Loop playlist: off" }));
  await waitFor(() => expect(calls("/program/main/audio-bus")).toHaveLength(2));
  expect(songSequence.loop).toBe(true);
});
it("reconciles a live song and its off-air event into the on-air player", async () => {
  loadPlaylist();
  await openAudio();
  const stream = FixtureEventSource.instances[0];
  stream.emit({
    type: "song_playback_update",
    programId: "main",
    version: 1,
    playback: {
      token: "song-1:take-1",
      audioUrl: "https://media.example/song-1.mp3",
      title: "First song",
      artist: "Studio artist",
      durationMs: 120000,
      currentTimeMs: 30000,
      isPlaying: true,
    },
  });
  await waitFor(() =>
    expect(
      within(screen.getByRole("region", { name: "On-air player" })).getByText(
        "First song",
      ),
    ).toBeInTheDocument(),
  );
  expect(
    screen.getByRole("progressbar", { name: "Track progress" }),
  ).toHaveAttribute("aria-valuenow", "25");
  stream.emit({ type: "song_off_air", programId: "main", version: 2 });
  await waitFor(() =>
    expect(
      within(screen.getByRole("region", { name: "On-air player" })).getByText(
        "Nothing on air",
      ),
    ).toBeInTheDocument(),
  );
});
