import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import GuestRoute, { meta } from "./guest";

// The remote guest's call page: preflight checks, joining the studio room,
// the selected return feed, and the director's commands. LiveKit, the
// browser's media devices and Web Audio are stand-ins.

const lk = vi.hoisted(() => {
  type Handler = (...args: unknown[]) => void;
  const state = { rooms: [] as InstanceType<typeof Room>[] };
  class Room {
    state = "disconnected";
    handlers = new Map<string, Handler>();
    remoteParticipants = new Map<
      string,
      { identity: string; trackPublications: Map<string, unknown> }
    >();
    connectedWith: unknown[] = [];
    disconnected = false;
    switched: [string, string][] = [];
    calls: string[] = [];
    preview = { attached: [] as unknown[] };
    connectError: unknown = null;
    localParticipant = {
      setCameraEnabled: async (enabled: boolean, options?: unknown) => {
        this.calls.push(`camera:${enabled}:${JSON.stringify(options ?? null)}`);
      },
      setMicrophoneEnabled: async (enabled: boolean, options?: unknown) => {
        this.calls.push(
          `microphone:${enabled}:${JSON.stringify(options ?? null)}`,
        );
      },
      getTrackPublication: () => ({
        videoTrack: {
          attach: (element: unknown) => this.preview.attached.push(element),
        },
      }),
    };
    constructor(readonly options: unknown) {
      state.rooms.push(this);
    }
    on(event: string, handler: Handler) {
      this.handlers.set(event, handler);
      return this;
    }
    emit(event: string, ...args: unknown[]) {
      this.handlers.get(event)?.(...args);
    }
    async connect(...args: unknown[]) {
      if (this.connectError) throw this.connectError;
      this.connectedWith = args;
      this.state = "connected";
    }
    async switchActiveDevice(kind: string, id: string) {
      this.switched.push([kind, id]);
    }
    disconnect() {
      this.disconnected = true;
    }
    removeAllListeners() {
      this.handlers.clear();
      return this;
    }
  }
  return { state, Room };
});

vi.mock("livekit-client", () => ({
  Room: lk.Room,
  DisconnectReason: {
    CLIENT_INITIATED: 0,
    PARTICIPANT_REMOVED: 1,
    ROOM_DELETED: 2,
    DUPLICATE_IDENTITY: 3,
  },
  ConnectionState: {
    Connected: "connected",
    Reconnecting: "reconnecting",
    Disconnected: "disconnected",
  },
  RoomEvent: {
    TrackPublished: "trackPublished",
    TrackSubscribed: "trackSubscribed",
    TrackUnsubscribed: "trackUnsubscribed",
    ConnectionStateChanged: "connectionStateChanged",
    Disconnected: "disconnected",
    ConnectionQualityChanged: "connectionQualityChanged",
    DataReceived: "dataReceived",
  },
  Track: {
    Kind: { Video: "video", Audio: "audio" },
    Source: { Camera: "camera" },
  },
}));
vi.mock("@gaulatti/bleecker", async (original) => {
  const kit = await import("../../test/routeKit");
  return kit.nativeSelect(
    original as () => Promise<typeof import("@gaulatti/bleecker")>,
  );
});

type FakeTrack = {
  kind: string;
  enabled: boolean;
  stopped: boolean;
  stop(): void;
  getSettings(): { deviceId?: string };
};
const track = (kind: string, deviceId?: string): FakeTrack => {
  const created: FakeTrack = {
    kind,
    enabled: true,
    stopped: false,
    stop() {
      created.stopped = true;
    },
    getSettings: () => (deviceId ? { deviceId } : {}),
  };
  return created;
};
const stream = (video: FakeTrack[], audio: FakeTrack[]) => ({
  getVideoTracks: () => video,
  getAudioTracks: () => audio,
  getTracks: () => [...video, ...audio],
});

let streams: ReturnType<typeof stream>[] = [];
let getUserMedia: ReturnType<typeof vi.fn>;
let tone: { started: boolean; closed: boolean };
let joinAnswer: () => Response;
let heartbeatStatus = 200;
let fetchCalls: { url: string; body: unknown }[] = [];

function devices(
  list = [
    { kind: "videoinput", deviceId: "cam-1", label: "Front camera" },
    { kind: "videoinput", deviceId: "cam-2", label: "" },
    { kind: "audioinput", deviceId: "mic-1", label: "Headset" },
    { kind: "audioinput", deviceId: "mic-2", label: "" },
    { kind: "audiooutput", deviceId: "out-1", label: "Speakers" },
  ],
) {
  return list;
}

beforeEach(() => {
  streams = [];
  lk.state.rooms = [];
  tone = { started: false, closed: false };
  heartbeatStatus = 200;
  fetchCalls = [];
  window.sessionStorage.clear();
  getUserMedia = vi.fn(async () => {
    const next = stream([track("video", "cam-1")], [track("audio", "mic-1")]);
    streams.push(next);
    return next;
  });
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia, enumerateDevices: vi.fn(async () => devices()) },
  });
  Object.defineProperty(navigator, "connection", {
    configurable: true,
    value: { effectiveType: "4g", downlink: 12, rtt: 40 },
  });
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
  vi.stubGlobal(
    "AudioContext",
    class {
      currentTime = 0;
      destination = {};
      createOscillator() {
        let ended: (() => void) | null = null;
        let stopped = false;
        return {
          frequency: { value: 0 },
          connect: (next: unknown) => next,
          start: () => {
            tone.started = true;
          },
          stop: () => {
            stopped = true;
            ended?.();
          },
          addEventListener: (_event: string, handler: () => void) => {
            ended = handler;
            if (stopped) handler();
          },
        };
      }
      createGain() {
        return { gain: { value: 0 }, connect: (next: unknown) => next };
      }
      async close() {
        tone.closed = true;
      }
    },
  );
  joinAnswer = () =>
    Response.json({
      serverUrl: "wss://livekit.example",
      token: "fictional-guest-token",
      sessionToken: "session-1",
      displayName: "Ada",
      programId: "main",
      participantIdentity: "guest-ada",
      returnVideo: "program",
      returnAudioBus: "aux-2",
    });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      fetchCalls.push({
        url,
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      if (url.endsWith("/webrtc/join")) return joinAnswer();
      if (url.endsWith("/webrtc/session/heartbeat"))
        return new Response(null, { status: heartbeatStatus });
      if (url.includes("/webrtc/commands/"))
        return new Response(null, { status: 204 });
      throw new Error(`unexpected ${url}`);
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function openPage(invitation = "inv-1.secret") {
  return render(
    <MemoryRouter initialEntries={[`/guest/${invitation}`]}>
      <Routes>
        <Route path="/guest/:invitation" element={<GuestRoute />} />
        <Route path="/guest" element={<GuestRoute />} />
      </Routes>
    </MemoryRouter>,
  );
}

const joinButton = () => screen.getByRole("button", { name: /Join studio/ });
const room = () => lk.state.rooms.at(-1)!;
const emit = (event: string, ...args: unknown[]) =>
  act(() => room().emit(event, ...args));
const director = (
  command: Record<string, unknown>,
  topic = "alcantara-director",
) =>
  emit(
    "dataReceived",
    new TextEncoder().encode(JSON.stringify(command)),
    undefined,
    undefined,
    topic,
  );

async function preflight() {
  expect(await screen.findByText("4g · 12 Mbps · 40 ms RTT")).toBeVisible();
  fireEvent.click(screen.getByText("Speaker test").closest("button")!);
  fireEvent.click(screen.getByLabelText(/I am wearing headphones/));
}

async function joined() {
  openPage();
  await preflight();
  fireEvent.click(joinButton());
  await screen.findByText("Ada · main · program video · aux-2 mix-minus");
}

it("has a page title", () => {
  expect(meta({} as never)).toEqual([{ title: "Guest Call - Alcántara" }]);
});

it("runs the preflight: devices, network, a speaker test and an echo check", async () => {
  openPage();
  expect(
    screen.getByText("Complete every preflight check, then join explicitly."),
  ).toBeVisible();
  expect(await screen.findByText("4g · 12 Mbps · 40 ms RTT")).toBeVisible();
  expect(screen.getByDisplayValue("Front camera")).toBeVisible();
  expect(screen.getByDisplayValue("Headset")).toBeVisible();
  expect(screen.getByRole("option", { name: "Camera 2" })).toBeInTheDocument();
  expect(
    screen.getByRole("option", { name: "Microphone 2" }),
  ).toBeInTheDocument();
  expect(joinButton()).toBeDisabled();

  fireEvent.click(screen.getByText("Speaker test").closest("button")!);
  expect(await screen.findByText("Completed")).toBeVisible();
  expect(tone).toEqual({ started: true, closed: true });
  expect(joinButton()).toBeDisabled();
  // The join waits for the headphones confirmation; the guest is not offered a way around it.
  expect(screen.queryByLabelText(/Operator accepted speaker risk/)).not.toBeInTheDocument();
  expect(screen.getByText("Confirm you are wearing headphones.")).toBeVisible();
  fireEvent.click(screen.getByLabelText(/I am wearing headphones/));
  expect(joinButton()).toBeEnabled();
  expect(screen.queryByText("Confirm you are wearing headphones.")).not.toBeInTheDocument();
});

it("says why the join is locked and which step comes next", async () => {
  openPage();
  expect(await screen.findByText("Play the test tone first.")).toBeVisible();
  expect(joinButton()).toHaveAttribute("aria-describedby", "join-blocked-reason");
  expect(screen.getByRole("list", { name: "Steps to join" })).toHaveTextContent("1. Play the test tone");
  expect(screen.getByText("Speaker test").closest("button")).toHaveAttribute("aria-current", "step");

  fireEvent.click(screen.getByText("Speaker test").closest("button")!);
  expect(await screen.findByText("Confirm you are wearing headphones.")).toBeVisible();
  expect(screen.getByRole("list", { name: "Steps to join" })).toHaveTextContent("2. Confirm headphones");
  expect(screen.getByText("Speaker test").closest("button")).not.toHaveAttribute("aria-current");
});

it("falls back to the first devices and a plain network note", async () => {
  Object.defineProperty(navigator, "connection", {
    configurable: true,
    value: undefined,
  });
  getUserMedia.mockImplementationOnce(async () =>
    stream([track("video")], [track("audio")]),
  );
  openPage();
  expect(await screen.findByText("Browser network check ready")).toBeVisible();
  expect(screen.getByDisplayValue("Front camera")).toBeVisible();
  expect(screen.getByDisplayValue("Headset")).toBeVisible();
});

it("describes a partial network report and no devices at all", async () => {
  Object.defineProperty(navigator, "connection", {
    configurable: true,
    value: {},
  });
  getUserMedia.mockImplementationOnce(async () => stream([], []));
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia, enumerateDevices: vi.fn(async () => []) },
  });
  openPage();
  expect(await screen.findByText("network · ? Mbps · ? ms RTT")).toBeVisible();
});

it.each([
  [new Error("Permission denied"), "The camera or microphone could not start."],
  ["blocked", "The camera or microphone could not start."],
])(
  "explains a camera or microphone that cannot be opened (%s)",
  async (failure, message) => {
    getUserMedia.mockRejectedValueOnce(failure);
    openPage();
    expect(await screen.findByRole("alert")).toHaveTextContent(message);
    expect(screen.getByText("error")).toBeVisible();
  },
);

it("releases media opened after the page already closed", async () => {
  let open!: (value: ReturnType<typeof stream>) => void;
  getUserMedia.mockReturnValueOnce(new Promise((resolve) => (open = resolve)));
  const view = openPage();
  view.unmount();
  const late = stream([track("video")], [track("audio")]);
  await act(async () => open(late));
  expect(late.getTracks().every((item) => item.stopped)).toBe(true);
});

it("switches devices before joining, keeping the current on and off choices", async () => {
  openPage();
  await screen.findByText("4g · 12 Mbps · 40 ms RTT");
  fireEvent.click(screen.getByRole("button", { name: /Camera on/ }));
  fireEvent.click(screen.getByRole("button", { name: /Mic on/ }));
  expect(streams[0].getVideoTracks()[0].enabled).toBe(false);
  expect(streams[0].getAudioTracks()[0].enabled).toBe(false);
  fireEvent.change(screen.getByDisplayValue("Front camera"), {
    target: { value: "cam-2" },
  });
  await waitFor(() => expect(streams).toHaveLength(2));
  expect(getUserMedia).toHaveBeenLastCalledWith({
    video: { deviceId: { exact: "cam-2" } },
    audio: { deviceId: { exact: "mic-1" }, echoCancellation: true },
  });
  expect(streams[0].getTracks().every((item) => item.stopped)).toBe(true);
  expect(streams[1].getVideoTracks()[0].enabled).toBe(false);
  fireEvent.change(screen.getByDisplayValue("Headset"), {
    target: { value: "mic-2" },
  });
  await waitFor(() => expect(streams).toHaveLength(3));
  expect(getUserMedia).toHaveBeenLastCalledWith({
    video: { deviceId: { exact: "cam-2" } },
    audio: { deviceId: { exact: "mic-2" }, echoCancellation: true },
  });
});

it("asks for any device when none was chosen yet", async () => {
  getUserMedia.mockImplementationOnce(async () =>
    stream([track("video")], [track("audio")]),
  );
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      getUserMedia,
      enumerateDevices: vi.fn(async () =>
        devices([{ kind: "videoinput", deviceId: "cam-9", label: "USB" }]),
      ),
    },
  });
  openPage();
  await screen.findByText("4g · 12 Mbps · 40 ms RTT");
  fireEvent.change(screen.getByDisplayValue("USB"), {
    target: { value: "cam-9" },
  });
  await waitFor(() =>
    expect(getUserMedia).toHaveBeenLastCalledWith({
      video: { deviceId: { exact: "cam-9" } },
      audio: true,
    }),
  );
});

it("joins the studio, subscribes only to its return feed and keeps the session", async () => {
  window.sessionStorage.setItem(
    "alcantara-guest-session:inv-1",
    "previous-session",
  );
  await joined();
  expect(
    fetchCalls.find((call) => call.url.endsWith("/webrtc/join"))!.body,
  ).toEqual({
    invitation: "inv-1.secret",
    sessionToken: "previous-session",
  });
  expect(window.sessionStorage.getItem("alcantara-guest-session:inv-1")).toBe(
    "session-1",
  );
  expect(room().connectedWith).toEqual([
    "wss://livekit.example",
    "fictional-guest-token",
    { autoSubscribe: false },
  ]);
  expect(room().calls).toEqual([
    'camera:true:{"deviceId":"cam-1"}',
    'microphone:true:{"deviceId":"mic-1"}',
  ]);
  expect(room().preview.attached).toHaveLength(1);
  expect(streams[0].getTracks().every((item) => item.stopped)).toBe(true);
  expect(screen.getByText("Connecting you to the studio sound…")).toBeVisible();
  expect(screen.getByText("live")).toBeVisible();
  await waitFor(() =>
    expect(fetchCalls.some((call) => call.url.endsWith("/heartbeat"))).toBe(
      true,
    ),
  );
  expect(
    fetchCalls.find((call) => call.url.endsWith("/heartbeat"))!.body,
  ).toMatchObject({
    sessionToken: "session-1",
    telemetry: { connectionState: "connected", returnFeedHealth: "missing" },
  });

  const subscribed: [string, boolean][] = [];
  const publication = (sid: string, kind: string, trackName = "") => ({
    kind,
    trackName,
    setSubscribed: async (value: boolean) => {
      subscribed.push([sid, value]);
    },
  });
  const program = { identity: "program-feed-main" };
  const preview = { identity: "preview-feed-main" };
  const router = { identity: "return-router-1" };
  const stranger = { identity: "guest-bo" };
  emit("trackPublished", publication("program-video", "video"), program);
  emit("trackPublished", publication("preview-video", "video"), preview);
  emit(
    "trackPublished",
    publication("mix", "audio", "mixminus:guest-ada:aux-2"),
    router,
  );
  emit(
    "trackPublished",
    publication("other-mix", "audio", "mixminus:guest-ada:master"),
    router,
  );
  emit("trackPublished", publication("stranger", "video"), stranger);
  expect(subscribed).toEqual([
    ["program-video", true],
    ["preview-video", false],
    ["mix", true],
    ["other-mix", false],
    ["stranger", false],
  ]);

  const attached: string[] = [];
  const remote = (kind: string) => ({
    kind,
    attach: () => attached.push(kind),
    detach: () => attached.push(`detached-${kind}`),
  });
  emit(
    "trackSubscribed",
    remote("video"),
    publication("stranger", "video"),
    stranger,
  );
  expect(attached).toEqual([]);
  emit(
    "trackSubscribed",
    remote("video"),
    publication("program-video", "video"),
    program,
  );
  emit(
    "trackSubscribed",
    remote("audio"),
    publication("mix", "audio", "mixminus:guest-ada:aux-2"),
    router,
  );
  expect(attached).toEqual(["video", "audio"]);
  expect(HTMLMediaElement.prototype.play).toHaveBeenCalled();
  expect(
    screen.queryByText("Connecting you to the studio sound…"),
  ).not.toBeInTheDocument();
  emit("trackUnsubscribed", remote("video"));
  expect(attached.at(-1)).toBe("detached-video");
  expect(screen.getByText("The studio sound dropped. It will come back by itself.")).toBeVisible();
});

// gaulatti/alexandria#9: the program return is the desktop's feed when it is in the
// room, otherwise Alana's. The switch attaches the new track before detaching the
// old one, both ways, so the guest never sees the waiting state in between.
it("switches the program return to the desktop's feed when it joins, and back when it leaves", async () => {
  await joined();
  const subscribed: [string, boolean][] = [];
  const publication = (sid: string, kind: string) => ({
    kind,
    trackName: "",
    setSubscribed: async (value: boolean) => {
      subscribed.push([sid, value]);
    },
  });
  const events: string[] = [];
  const remote = (name: string) => ({
    kind: "video",
    attach: () => events.push(`attach ${name}`),
    detach: () => events.push(`detach ${name}`),
  });
  const alana = { identity: "program-feed-main" };
  const desktop = { identity: "desktop-program-feed-main" };
  const alanaTrack = remote("alana");
  const desktopTrack = remote("desktop");

  emit("trackPublished", publication("alana-video", "video"), alana);
  emit("trackSubscribed", alanaTrack, publication("alana-video", "video"), alana);
  expect(events).toEqual(["attach alana"]);

  // The desktop joins mid-session: both feeds stay subscribed, the desktop's is shown.
  emit("trackPublished", publication("desktop-video", "video"), desktop);
  expect(subscribed).toEqual([
    ["alana-video", true],
    ["desktop-video", true],
  ]);
  emit("trackSubscribed", desktopTrack, publication("desktop-video", "video"), desktop);
  expect(events).toEqual(["attach alana", "attach desktop", "detach alana"]);
  expect(screen.queryByText("Connecting you to the studio sound…")).not.toBeInTheDocument();

  // The desktop leaves: Alana's feed is attached before the desktop's is let go.
  emit("trackUnsubscribed", desktopTrack, publication("desktop-video", "video"), desktop);
  expect(events).toEqual([
    "attach alana",
    "attach desktop",
    "detach alana",
    "attach alana",
    "detach desktop",
  ]);
  expect(screen.queryByText("Connecting you to the studio sound…")).not.toBeInTheDocument();

  // Alana's feed going away too leaves the guest waiting, as before.
  emit("trackUnsubscribed", alanaTrack, publication("alana-video", "video"), alana);
  expect(events.at(-1)).toBe("detach alana");
  expect(screen.getByText("The studio sound dropped. It will come back by itself.")).toBeVisible();
});

// The desktop feed's sound is a microphone-source track ("program-audio"). A guest never
// subscribes to it directly: guests hear the program through their own mix-minus, which the
// return router builds, so the program is not heard twice and never as a guest microphone.
it("does not subscribe to the desktop feed's program-audio track", async () => {
  await joined();
  const subscribed: [string, boolean][] = [];
  const publication = (sid: string, kind: string, trackName: string, source: string) => ({
    kind,
    trackName,
    source,
    setSubscribed: async (value: boolean) => {
      subscribed.push([sid, value]);
    },
  });
  const desktop = { identity: "desktop-program-feed-main" };
  emit("trackPublished", publication("desktop-audio", "audio", "program-audio", "microphone"), desktop);
  emit("trackPublished", publication("desktop-video", "video", "program", "screen_share"), desktop);
  expect(subscribed).toEqual([
    ["desktop-audio", false],
    ["desktop-video", true],
  ]);
});

it("keeps the desktop's feed when Alana's arrives after it", async () => {
  await joined();
  const events: string[] = [];
  const publication = { kind: "video", trackName: "", setSubscribed: async () => {} };
  const remote = (name: string) => ({
    kind: "video",
    attach: () => events.push(`attach ${name}`),
    detach: () => events.push(`detach ${name}`),
  });
  emit("trackSubscribed", remote("desktop"), publication, { identity: "desktop-program-feed-main" });
  emit("trackSubscribed", remote("alana"), publication, { identity: "program-feed-main" });
  expect(events).toEqual(["attach desktop"]);
});

it("subscribes to feeds that were already in the room when it joined", async () => {
  const subscribed: [string, boolean][] = [];
  const original = lk.Room.prototype.connect;
  lk.Room.prototype.connect = async function (
    this: InstanceType<typeof lk.Room>,
  ) {
    this.state = "connected";
    this.remoteParticipants.set("program-feed-main", {
      identity: "program-feed-main",
      trackPublications: new Map([
        [
          "v",
          {
            kind: "video",
            trackName: "",
            setSubscribed: async (value: boolean) =>
              subscribed.push(["v", value]),
          },
        ],
      ]),
    });
  };
  try {
    await joined();
  } finally {
    lk.Room.prototype.connect = original;
  }
  expect(subscribed).toEqual([["v", true]]);
});

it("says the studio sound is connecting until a return arrives, and keeps the self-view", async () => {
  await joined();
  expect(screen.getByText("Connecting you to the studio sound…")).toBeVisible();
  const selfView = document.querySelector("video.z-10") as HTMLVideoElement;
  expect(selfView).toHaveClass("z-10");
  expect(document.querySelector("video.z-10")).toBe(selfView);
});

it("says the studio sound is playing, with a level meter, once the return is heard", async () => {
  await joined();
  const attached: string[] = [];
  const remote = (kind: string) => ({
    kind,
    attach: () => attached.push(kind),
    detach: () => attached.push(`detached-${kind}`),
  });
  const router = { identity: "return-router-main", audioLevel: 0.4 };
  const mix = {
    kind: "audio",
    trackName: "mixminus:guest-ada:aux-2",
    setSubscribed: async () => {},
  };
  emit("trackSubscribed", remote("audio"), mix, router);
  expect(attached).toEqual(["audio"]);
  expect(screen.getByText("You're hearing the studio")).toBeVisible();
  expect(screen.getByRole("meter", { name: "Studio sound level" })).toBeInTheDocument();
  expect(screen.queryByText("Connecting you to the studio sound…")).not.toBeInTheDocument();
});

// Fifteen seconds on air without the return says so, in plain words; the timer is captured rather than waited for.
const STALL = "The studio sound isn't reaching you yet. The producer can see this; you can keep talking.";
function captureStallTimers() {
  const timers: Array<{ fn: () => void; delay: number }> = [];
  const original = window.setTimeout.bind(window);
  const spy = vi.spyOn(window, "setTimeout").mockImplementation(((fn: () => void, delay?: number, ...rest: unknown[]) => {
    timers.push({ fn, delay: Number(delay) });
    return original(fn, delay, ...rest);
  }) as typeof window.setTimeout);
  const latest = () => [...timers].reverse().find((timer) => timer.delay === 15_000);
  return { spy, latest };
}

it("says the sound is not reaching the guest after 15 s on air with no return, and clears it when the return arrives", async () => {
  const { spy, latest } = captureStallTimers();
  try {
    await joined();
    expect(screen.getByText("Connecting you to the studio sound…")).toBeVisible();
    const stall = latest();
    expect(stall).toBeDefined();
    expect(stall!.delay).toBe(15_000);
    act(() => stall!.fn());
    expect(screen.getByText(STALL)).toBeVisible();

    const attached: string[] = [];
    const mix = {
      kind: "audio",
      attach: () => attached.push("audio"),
      detach: () => attached.push("detached-audio"),
    };
    const publication = { kind: "audio", trackName: "mixminus:guest-ada:aux-2", setSubscribed: async () => {} };
    emit("trackSubscribed", mix, publication, { identity: "return-router-main", audioLevel: 0.2 });
    expect(screen.getByText("You're hearing the studio")).toBeVisible();
    expect(screen.queryByText(STALL)).not.toBeInTheDocument();
  } finally {
    spy.mockRestore();
  }
});

it("says the sound is not reaching the guest when a drop lasts 15 s, and clears it when the return is back", async () => {
  const { spy, latest } = captureStallTimers();
  try {
    await joined();
    const attached: string[] = [];
    const mix = {
      kind: "audio",
      attach: () => attached.push("audio"),
      detach: () => attached.push("detached-audio"),
    };
    const publication = { kind: "audio", trackName: "mixminus:guest-ada:aux-2", setSubscribed: async () => {} };
    const router = { identity: "return-router-main", audioLevel: 0.2 };
    emit("trackSubscribed", mix, publication, router);
    expect(screen.getByText("You're hearing the studio")).toBeVisible();

    emit("trackUnsubscribed", mix, publication, router);
    expect(screen.getByText("The studio sound dropped. It will come back by itself.")).toBeVisible();
    const stall = latest();
    expect(stall).toBeDefined();
    act(() => stall!.fn());
    expect(screen.getByText(STALL)).toBeVisible();

    emit("trackSubscribed", mix, publication, router);
    expect(screen.getByText("You're hearing the studio")).toBeVisible();
  } finally {
    spy.mockRestore();
  }
});

it("takes no return video when the guest's return is set to none", async () => {
  joinAnswer = () =>
    Response.json({
      serverUrl: "wss://livekit.example",
      token: "t",
      sessionToken: "s",
      displayName: "Ada",
      programId: "main",
      participantIdentity: "guest-ada",
      returnVideo: "none",
      returnAudioBus: "master",
    });
  openPage();
  await preflight();
  fireEvent.click(joinButton());
  await screen.findByText("Ada · main · none video · master mix-minus");
  const subscribed: boolean[] = [];
  emit(
    "trackPublished",
    {
      kind: "video",
      trackName: "",
      setSubscribed: async (value: boolean) => subscribed.push(value),
    },
    { identity: "program-feed-main" },
  );
  expect(subscribed).toEqual([false]);
});

// guest.fixes.test.tsx covers each refusal's message and retry; these two add
// the answers without a JSON body.
it("names an empty refusal by its status and lets the guest try again", async () => {
  joinAnswer = () => new Response("", { status: 500 });
  openPage();
  await preflight();
  fireEvent.click(joinButton());
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Request failed (500)",
  );
  expect(joinButton()).toBeEnabled();
});

it("ends the session on a refused invitation whose answer is plain text", async () => {
  joinAnswer = () => new Response("not json", { status: 403 });
  openPage();
  await preflight();
  fireEvent.click(joinButton());
  expect(await screen.findByText("The studio session ended.")).toBeVisible();
  expect(screen.getByRole("alert")).toHaveTextContent("not json");
});

it("explains a join whose room connection fails, for an invitation without a key", async () => {
  const original = lk.Room.prototype.connect;
  lk.Room.prototype.connect = async () => {
    throw "unreachable";
  };
  try {
    openPage(".nokey");
    await preflight();
    fireEvent.click(joinButton());
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not connect to the studio.",
    );
  } finally {
    lk.Room.prototype.connect = original;
  }
  expect(window.sessionStorage.getItem("alcantara-guest-session:unknown")).toBe(
    "session-1",
  );
});

it("follows the room's connection and quality", async () => {
  await joined();
  emit("connectionStateChanged", "reconnecting");
  expect(screen.getByText("reconnecting")).toBeVisible();
  emit("connectionStateChanged", "connected");
  expect(screen.getByText("live")).toBeVisible();
  emit("connectionQualityChanged", "EXCELLENT", { isLocal: false });
  emit("connectionQualityChanged", "GOOD", { isLocal: true });
  emit("connectionStateChanged", "disconnected");
  expect(screen.getByText("The studio session ended.")).toBeVisible();
});

it("ends the call when the studio revokes the session", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  await joined();
  heartbeatStatus = 403;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(20_000);
  });
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "The studio ended or revoked this guest session.",
  );
  expect(room().disconnected).toBe(true);
  // A session the studio ended can be rejoined while the invitation is open (gaulatti/alcantara#353),
  // and the message is shown once, in the ended panel.
  expect(screen.getAllByRole("alert")).toHaveLength(1);
  expect(
    screen.getByRole("button", { name: "Rejoin the studio" }),
  ).toBeInTheDocument();
});

// A phone that slept past the reconnect window: nobody ended or revoked anything, and the page must not say so.
it("says the guest was away too long when the session lapsed while the phone slept", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  await joined();
  // The phone wakes ninety seconds later; the next heartbeat is refused.
  vi.setSystemTime(Date.now() + 90_000);
  heartbeatStatus = 401;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(20_000);
  });
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "You were away too long, so the studio let go of the call. Rejoin to come back.",
  );
  expect(screen.queryByText(/ended or revoked/)).toBeNull();
  expect(screen.getByRole("button", { name: "Rejoin the studio" })).toBeVisible();
});

it("asks the studio at once when the phone wakes, without waiting for the next beat", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  await joined();
  const beats = () => fetchCalls.filter((call) => call.url.includes("/webrtc/session/heartbeat")).length;
  const visibility = vi.spyOn(document, "visibilityState", "get");
  visibility.mockReturnValue("hidden");
  const before = beats();
  await act(async () => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
  expect(beats()).toBe(before);
  visibility.mockReturnValue("visible");
  await act(async () => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await waitFor(() => expect(beats()).toBe(before + 1));
  visibility.mockRestore();
});

it("ends the call when the studio no longer recognizes the session", async () => {
  heartbeatStatus = 401;
  openPage();
  await preflight();
  fireEvent.click(joinButton());
  expect(await screen.findByText("The studio session ended.")).toBeVisible();
  expect(screen.getByRole("alert")).toHaveTextContent(
    "The studio ended or revoked this guest session.",
  );
  expect(room().disconnected).toBe(true);
});

it("follows the director's mute, request, cue, message and return commands", async () => {
  await joined();
  const acks = () =>
    fetchCalls.filter((call) => call.url.includes("/webrtc/commands/"));

  director({ id: "c1", type: "media", device: "camera", enabled: false });
  await waitFor(() =>
    expect(screen.getByRole("button", { name: /Camera off/ })).toBeVisible(),
  );
  director({ id: "c2", type: "media", device: "microphone", enabled: false });
  await waitFor(() =>
    expect(screen.getByRole("button", { name: /Mic off/ })).toBeVisible(),
  );
  expect(
    acks().map((call) => [
      call.url.split("/").at(-2),
      (call.body as { status: string }).status,
    ]),
  ).toEqual([
    ["c1", "accepted"],
    ["c2", "accepted"],
  ]);

  director({ id: "c3", type: "media", device: "camera", enabled: true });
  expect(await screen.findByText("Studio requests your camera.")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Accept" }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: /Camera on/ })).toBeVisible(),
  );
  director({ id: "c4", type: "media", device: "microphone", enabled: true });
  fireEvent.click(await screen.findByRole("button", { name: "Accept" }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: /Mic on/ })).toBeVisible(),
  );
  director({ id: "c5", type: "media", device: "camera", enabled: true });
  fireEvent.click(await screen.findByRole("button", { name: "Decline" }));
  await waitFor(() =>
    expect(
      screen.queryByRole("button", { name: "Decline" }),
    ).not.toBeInTheDocument(),
  );
  expect(
    acks()
      .slice(2)
      .map((call) => (call.body as { status: string }).status),
  ).toEqual(["accepted", "accepted", "rejected"]);

  director({ id: "c6", type: "cue", cue: "live" });
  expect(await screen.findByText("live", { selector: "strong" })).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: /Acknowledge/ }));
  await waitFor(() =>
    expect(
      screen.queryByText("live", { selector: "strong" }),
    ).not.toBeInTheDocument(),
  );
  director({ id: "c7", type: "message", text: "You are on in 10" });
  // A message posts its read receipt at once and stays until acknowledged.
  await waitFor(() =>
    expect((acks().at(-1)!.body as { status: string }).status).toBe("read"),
  );
  fireEvent.click(screen.getByRole("button", { name: /Acknowledge/ }));
  await waitFor(() =>
    expect(screen.queryByText("You are on in 10")).not.toBeInTheDocument(),
  );

  director({
    id: "c8",
    type: "return",
    returnVideo: "preview",
    returnAudioBus: "monitor",
  });
  expect(
    await screen.findByText("Ada · main · preview video · monitor mix-minus"),
  ).toBeVisible();
  director({ id: "c9", type: "return" });
  expect(
    screen.getByText("Ada · main · preview video · monitor mix-minus"),
  ).toBeVisible();

  // Other topics, commands without an id and unreadable data are ignored.
  director({ id: "c10", type: "cue", cue: "wrap" }, "chat");
  director({ type: "cue", cue: "wrap" });
  emit(
    "dataReceived",
    new TextEncoder().encode("{nope"),
    undefined,
    undefined,
    "alcantara-director",
  );
  expect(screen.queryByText("wrap")).not.toBeInTheDocument();
});

it("toggles media in the room and leaves the studio", async () => {
  await joined();
  fireEvent.click(screen.getByRole("button", { name: /Camera on/ }));
  fireEvent.click(screen.getByRole("button", { name: /Mic on/ }));
  await waitFor(() =>
    expect(room().calls.slice(-2)).toEqual([
      "camera:false:null",
      "microphone:false:null",
    ]),
  );
  fireEvent.click(screen.getByRole("button", { name: /Leave/ }));
  expect(screen.getByText("You left the studio.")).toBeVisible();
  expect(room().disconnected).toBe(true);
});

// Most guests are on phones: a director's note must not hide the status, be cut off, or outlive the call.
it("shows a director's note under the picture, and drops it once the guest has left", async () => {
  await joined();
  director({ id: "c7", type: "message", text: "Thirty seconds, then you are on." });
  const note = await screen.findByText("Thirty seconds, then you are on.");
  expect(note.closest(".aspect-video")).toBeNull();
  expect(screen.getByRole("main").className).toContain("[&_button]:min-h-11");
  fireEvent.click(screen.getByRole("button", { name: /Leave/ }));
  expect(screen.getByText("You left the studio.")).toBeVisible();
  // Over the "left" panel it covered Rejoin.
  expect(screen.queryByText("Thirty seconds, then you are on.")).toBeNull();
  expect(screen.getByRole("button", { name: /Rejoin the studio/ })).toBeVisible();
});

it("lets the guest try again when the camera fails after the room connected", async () => {
  const original = lk.Room.prototype.connect;
  lk.Room.prototype.connect = async function (
    this: InstanceType<typeof lk.Room>,
  ) {
    this.state = "connected";
    this.localParticipant.setCameraEnabled = async () => {
      throw new Error("Camera busy");
    };
  };
  try {
    openPage();
    await preflight();
    fireEvent.click(joinButton());
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not connect to the studio.",
    );
  } finally {
    lk.Room.prototype.connect = original;
  }
  expect(joinButton()).toBeEnabled();
});

it("waits for both preflight checks before joining", async () => {
  openPage();
  await screen.findByText("4g · 12 Mbps · 40 ms RTT");
  fireEvent.click(screen.getByLabelText(/I am wearing headphones/));
  expect(joinButton()).toBeDisabled();
});

// gaulatti/alcantara#404 (guest route): a single-feed return (preview or alana) is shown when it arrives and released
// when it leaves.
it("shows a single-feed return when it arrives and waits again when it leaves", async () => {
  joinAnswer = () =>
    Response.json({
      serverUrl: "wss://livekit.example",
      token: "fictional-guest-token",
      sessionToken: "session-1",
      displayName: "Ada",
      programId: "main",
      participantIdentity: "guest-ada",
      returnVideo: "preview",
      returnAudioBus: "aux-2",
    });
  openPage();
  await preflight();
  fireEvent.click(joinButton());
  await screen.findByText("Ada · main · preview video · aux-2 mix-minus");
  const attached: string[] = [];
  const track = {
    kind: "video",
    attach: () => attached.push("attach"),
    detach: () => attached.push("detach"),
  };
  const publication = {
    kind: "video",
    trackName: "",
    setSubscribed: async () => {},
  };
  const preview = { identity: "preview-feed-main" };
  emit("trackSubscribed", track, publication, preview);
  expect(attached).toEqual(["attach"]);
  expect(
    screen.queryByText("Connecting you to the studio sound…"),
  ).not.toBeInTheDocument();
  emit("trackUnsubscribed", track, publication, preview);
  expect(attached).toEqual(["attach", "detach"]);
  expect(screen.getByText("The studio sound dropped. It will come back by itself.")).toBeVisible();
});
// gaulatti/alcantara#624 (guest.tsx deep routes): the paths that need the call's state traced to reach.

it("shows a refusal's whole answer when its JSON names no message", async () => {
  joinAnswer = () =>
    Response.json({ reason: "fictional-refusal" }, { status: 400 });
  openPage();
  await preflight();
  fireEvent.click(joinButton());
  expect(await screen.findByRole("alert")).toHaveTextContent(
    '{"reason":"fictional-refusal"}',
  );
  expect(joinButton()).toBeEnabled();
});

it("sends no heartbeat and no command receipt for a join answer without a session token", async () => {
  joinAnswer = () =>
    Response.json({
      serverUrl: "wss://livekit.example",
      token: "fictional-guest-token",
      sessionToken: "",
      displayName: "Ada",
      programId: "main",
      participantIdentity: "guest-ada",
      returnVideo: "program",
      returnAudioBus: "aux-2",
    });
  await joined();
  await director({ id: "c-1", type: "message", text: "Fictional note" });
  expect(await screen.findByText("Fictional note")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: /Acknowledge/ }));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  expect(
    fetchCalls.filter(
      (call) =>
        call.url.endsWith("/webrtc/session/heartbeat") ||
        call.url.includes("/webrtc/commands/"),
    ),
  ).toEqual([]);
});

it("rejoins the studio with the session it kept after the session ended", async () => {
  await joined();
  emit("connectionStateChanged", "disconnected");
  expect(await screen.findByText("The studio session ended.")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Rejoin the studio" }));
  await screen.findByText("Ada · main · program video · aux-2 mix-minus");
  const joins = fetchCalls.filter((call) => call.url.endsWith("/webrtc/join"));
  expect(joins).toHaveLength(2);
  expect(joins[1].body).toEqual({
    invitation: "inv-1.secret",
    sessionToken: "session-1",
  });
  expect(lk.state.rooms).toHaveLength(2);
});

it("switches the device in the earlier room while it still reports connected after a refused rejoin", async () => {
  await joined();
  const earlier = room();
  fireEvent.click(screen.getByRole("button", { name: /Leave/ }));
  expect(await screen.findByText("You left the studio.")).toBeVisible();
  // LiveKit finishes disconnecting on its own time: until then the room still reports connected.
  earlier.state = "connected";
  joinAnswer = () => new Response("", { status: 409 });
  fireEvent.click(screen.getByRole("button", { name: "Rejoin the studio" }));
  const camera = await screen.findByDisplayValue("Front camera");
  const opened = getUserMedia.mock.calls.length;
  fireEvent.change(camera, { target: { value: "cam-2" } });
  await waitFor(() =>
    expect(earlier.switched).toEqual([["videoinput", "cam-2"]]),
  );
  // The switch went to the room; the local camera was not opened again.
  expect(getUserMedia.mock.calls).toHaveLength(opened);
});

it("asks for any camera when the microphone is switched before a camera was chosen", async () => {
  getUserMedia.mockImplementationOnce(async () =>
    stream([track("video")], [track("audio", "mic-1")]),
  );
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      getUserMedia,
      enumerateDevices: vi.fn(async () =>
        devices([
          { kind: "audioinput", deviceId: "mic-1", label: "Headset" },
          { kind: "audioinput", deviceId: "mic-2", label: "Desk mic" },
        ]),
      ),
    },
  });
  openPage();
  await screen.findByText("4g · 12 Mbps · 40 ms RTT");
  fireEvent.change(screen.getByDisplayValue("Headset"), {
    target: { value: "mic-2" },
  });
  await waitFor(() =>
    expect(getUserMedia).toHaveBeenLastCalledWith({
      video: true,
      audio: { deviceId: { exact: "mic-2" }, echoCancellation: true },
    }),
  );
});

describe("the guest page on a phone", () => {
  const IPHONE_SAFARI =
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
  const ANDROID_CHROME =
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36";
  const named = (name: string) => Object.assign(new Error(name), { name });

  it("explains a blocked camera in iOS Safari's own words, and tries again once allowed", async () => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(IPHONE_SAFARI);
    getUserMedia.mockRejectedValueOnce(named("NotAllowedError"));
    openPage();
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Camera or microphone access is blocked.");
    expect(alert).toHaveTextContent("Settings app, then Safari, then Camera and Microphone.");
    fireEvent.click(within(alert).getByRole("button", { name: "Try again" }));
    await screen.findByText("4g · 12 Mbps · 40 ms RTT");
    expect(getUserMedia).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("explains a blocked camera in Android Chrome's own words", async () => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(ANDROID_CHROME);
    getUserMedia.mockRejectedValueOnce(named("NotAllowedError"));
    openPage();
    expect(await screen.findByRole("alert")).toHaveTextContent("Tap Permissions, then set Camera and Microphone to Allow.");
  });

  it.each([
    ["NotFoundError", "No camera or microphone was found."],
    ["NotReadableError", "The camera or microphone is in use."],
  ])("says what is wrong when the device fails with %s", async (name, title) => {
    getUserMedia.mockRejectedValueOnce(named(name));
    openPage();
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(title);
    expect(within(alert).getByRole("button", { name: "Try again" })).toBeEnabled();
  });

  it("names a connection that cannot reach the studio, and keeps the join ready to try again", async () => {
    const original = lk.Room.prototype.connect;
    lk.Room.prototype.connect = async () => {
      throw new Error("ICE failed");
    };
    try {
      openPage();
      await preflight();
      fireEvent.click(joinButton());
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "Could not connect to the studio. Check your Wi-Fi or mobile data, then try again.",
      );
    } finally {
      lk.Room.prototype.connect = original;
    }
    expect(joinButton()).toBeEnabled();
  });

  it("says an invitation that was replaced or revoked needs a new link, and offers no rejoin", async () => {
    joinAnswer = () =>
      new Response(JSON.stringify({ message: "This invitation was revoked." }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      });
    openPage();
    await preflight();
    fireEvent.click(joinButton());
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This invitation was revoked. Ask the studio for a new link.",
    );
    expect(screen.queryByRole("button", { name: "Rejoin the studio" })).toBeNull();
  });

  it("names a dropped connection and rejoins with the kept session", async () => {
    await joined();
    act(() => room().emit("connectionStateChanged", "disconnected"));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Your connection to the studio dropped. Check your Wi-Fi or mobile data, then rejoin.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Rejoin the studio" }));
    await screen.findByText("Ada · main · program video · aux-2 mix-minus");
    const joins = fetchCalls.filter((call) => call.url.endsWith("/webrtc/join"));
    expect(joins).toHaveLength(2);
    expect(joins[1].body).toEqual({ invitation: "inv-1.secret", sessionToken: "session-1" });
  });

  it("does not report leaving the call as a dropped connection", async () => {
    await joined();
    fireEvent.click(screen.getByRole("button", { name: /Leave/ }));
    expect(await screen.findByText("You left the studio.")).toBeVisible();
    expect(screen.queryByText(/dropped/)).toBeNull();
  });
});

// The studio removing the guest is not a network drop: the page says so, and offers the same link again.
it("says the studio removed the guest, not that the connection dropped", async () => {
  await joined();
  act(() => room().emit("disconnected", 1));
  expect(await screen.findByText("The studio removed you from the call. You can rejoin with the same link.")).toBeVisible();
  expect(screen.queryByText(/dropped/)).toBeNull();
  expect(screen.getByRole("button", { name: "Rejoin the studio" })).toBeInTheDocument();
});

// A studio that stops answering mid-call, and events that arrive out of the usual order.
describe("the guest page when the studio cannot be reached", () => {
  const dropHeartbeats = () => {
    const original = globalThis.fetch;
    const dropped = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/webrtc/session/heartbeat")) throw new TypeError("offline");
      return original(input, init);
    });
    vi.stubGlobal("fetch", dropped);
    return () => dropped.mock.calls.filter(([input]) => String(input).endsWith("/webrtc/session/heartbeat")).length;
  };

  it("stays in the call when the beats on waking, reconnecting and confirming a cue all fail, and still leaves", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await joined();
    const attempts = dropHeartbeats();
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await emit("connectionStateChanged", "reconnecting");
    await emit("connectionStateChanged", "connected");
    await director({ id: "c-9", type: "cue", cue: "live" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(attempts()).toBeGreaterThanOrEqual(3);
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Leave/ }));
    expect(await screen.findByText("You left the studio.")).toBeVisible();
  });

  it("does not read the cue again for a connected state that followed no reconnect", async () => {
    await joined();
    const attempts = dropHeartbeats();
    await emit("connectionStateChanged", "connected");
    expect(attempts()).toBe(0);
  });

  it("keeps saying the studio removed the guest when the room then reports disconnected", async () => {
    await joined();
    await emit("disconnected", 1);
    await emit("connectionStateChanged", "disconnected");
    expect(screen.queryByText(/Your connection to the studio dropped/)).toBeNull();
    expect(screen.getByRole("alert")).toHaveTextContent(/removed/i);
  });

  it("joins with a studio-given reconnect window, and reads a silent level for a source that reports none", async () => {
    joinAnswer = () =>
      Response.json({
        serverUrl: "wss://livekit.example",
        token: "fictional-guest-token",
        sessionToken: "session-1",
        reconnectWindowSeconds: 30,
        displayName: "Ada",
        programId: "main",
        participantIdentity: "guest-ada",
        returnVideo: "program",
        returnAudioBus: "aux-2",
      });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await joined();
    const router: { identity: string; audioLevel?: number } = { identity: "return-router-main" };
    emit(
      "trackSubscribed",
      { kind: "audio", attach: () => {}, detach: () => {} },
      { kind: "audio", trackName: "mixminus:guest-ada:aux-2", setSubscribed: async () => {} },
      router,
    );
    const meter = screen.getByRole("meter", { name: "Studio sound level" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(meter).toHaveAttribute("aria-valuenow", "0");
    router.audioLevel = Number.NaN;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(meter).toHaveAttribute("aria-valuenow", "0");
    router.audioLevel = 7;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(meter).toHaveAttribute("aria-valuenow", "100");
  });

  it("keeps the shown program feed when the other one leaves", async () => {
    await joined();
    const shown: string[] = [];
    const feed = (name: string) => ({
      kind: "video",
      attach: () => shown.push(name),
      detach: () => shown.push(`detached-${name}`),
    });
    const publication = { kind: "video", trackName: "", setSubscribed: async () => {} };
    const alana = feed("alana");
    const desktop = feed("desktop");
    emit("trackSubscribed", desktop, publication, { identity: "desktop-feed-main" });
    emit("trackSubscribed", alana, publication, { identity: "program-feed-main" });
    const before = [...shown];
    const other = before.at(-1) === "desktop" ? { track: alana, identity: "program-feed-main" } : { track: desktop, identity: "desktop-feed-main" };
    emit("trackUnsubscribed", other.track, publication, { identity: other.identity });
    expect(shown.filter((entry) => entry === `detached-${before.at(-1)}`)).toEqual([]);
  });

  it("says nothing more when the camera is refused after the page has closed", async () => {
    let refuse!: (reason: unknown) => void;
    getUserMedia.mockImplementation(() => new Promise((_resolve, reject) => (refuse = reject)));
    const view = openPage();
    view.unmount();
    await act(async () => refuse(new DOMException("denied", "NotAllowedError")));
    expect(fetchCalls.filter((call) => call.url.includes("/webrtc/"))).toEqual([]);
  });
});
