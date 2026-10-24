import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router";
import GuestRoute, { meta } from "./guest";

const nativeSetInterval = window.setInterval.bind(window);
const sdk = vi.hoisted(() => ({ createRoom: null as any }));
vi.mock("livekit-client", () => ({
  Room: vi.fn(function () {
    return sdk.createRoom();
  }),
  ConnectionState: {
    Connected: "connected",
    Reconnecting: "reconnecting",
    Disconnected: "disconnected",
  },
  RoomEvent: Object.fromEntries(
    [
      "TrackPublished",
      "TrackSubscribed",
      "TrackUnsubscribed",
      "ConnectionStateChanged",
      "ConnectionQualityChanged",
      "DataReceived",
    ].map((name) => [name, name]),
  ),
  Track: {
    Kind: { Video: "video", Audio: "audio" },
    Source: { Camera: "camera" },
  },
}));

let room: any;
let handlers: Record<string, (...args: any[]) => any>;
let video: any;
let audio: any;
let stream: any;
let devices: any[];
let interval: (() => void) | undefined;
let getUserMedia: ReturnType<typeof vi.fn>;
let requests: { path: string; body: any }[];
let joinResponse: () => Promise<Response>;
let heartbeatStatus: number;
let oscillator: any;
let audioContext: any;
const credentials = {
  serverUrl: "wss://room.example.invalid",
  token: "public-fixture-token",
  sessionToken: "public-fixture-session",
  displayName: "Invited guest",
  programId: "morning",
  participantIdentity: "guest-one",
  returnVideo: "program",
  returnAudioBus: "master",
};
const tick = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

beforeEach(() => {
  handlers = {};
  video = {
    enabled: true,
    stop: vi.fn(),
    getSettings: () => ({ deviceId: "camera-one" }),
  };
  audio = {
    enabled: true,
    stop: vi.fn(),
    getSettings: () => ({ deviceId: "microphone-one" }),
  };
  stream = {
    getTracks: () => [video, audio],
    getVideoTracks: () => [video],
    getAudioTracks: () => [audio],
  };
  devices = [
    { kind: "videoinput", deviceId: "camera-one", label: "Studio camera" },
    { kind: "videoinput", deviceId: "camera-two", label: "" },
    {
      kind: "audioinput",
      deviceId: "microphone-one",
      label: "Studio microphone",
    },
    { kind: "audioinput", deviceId: "microphone-two", label: "" },
    { kind: "audiooutput", deviceId: "speaker", label: "Speaker" },
  ];
  getUserMedia = vi.fn(async () => stream);
  vi.stubGlobal(
    "navigator",
    Object.assign(Object.create(navigator), {
      mediaDevices: {
        getUserMedia,
        enumerateDevices: vi.fn(async () => devices),
      },
    }),
  );
  room = {
    state: "connected",
    on: vi.fn((name, handler) => {
      handlers[name] = handler;
      return room;
    }),
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(),
    switchActiveDevice: vi.fn(async () => {}),
    remoteParticipants: new Map(),
    localParticipant: {
      setCameraEnabled: vi.fn(async () => {}),
      setMicrophoneEnabled: vi.fn(async () => {}),
      getTrackPublication: vi.fn(() => ({ videoTrack: { attach: vi.fn() } })),
    },
  };
  sdk.createRoom = () => room;
  requests = [];
  heartbeatStatus = 200;
  joinResponse = async () => Response.json(credentials);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), "http://localhost").pathname;
      requests.push({ path, body: JSON.parse(String(init?.body || "{}")) });
      if (path === "/webrtc/join") return joinResponse();
      if (path === "/webrtc/session/heartbeat")
        return new Response(null, { status: heartbeatStatus });
      if (/^\/webrtc\/commands\/[^/]+\/ack$/.test(path))
        return Response.json({ ok: true });
      throw new Error(`Unexpected guest request ${path}`);
    }),
  );
  sessionStorage.clear();
  interval = undefined;
  vi.spyOn(window, "setInterval").mockImplementation(((
    handler: TimerHandler,
    timeout?: number,
    ...args: any[]
  ) => {
    if (timeout === 20_000) {
      interval = handler as () => void;
      return 7;
    }
    return nativeSetInterval(handler, timeout, ...args);
  }) as typeof window.setInterval);
  vi.spyOn(window, "clearInterval");
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
  oscillator = {
    frequency: { value: 0 },
    connect: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    addEventListener: vi.fn(),
  };
  audioContext = {
    destination: {},
    currentTime: 12,
    createOscillator: () => oscillator,
    createGain: () => ({ gain: { value: 0 }, connect: vi.fn() }),
    close: vi.fn(),
  };
  oscillator.connect.mockImplementation((gain: any) => gain);
  vi.stubGlobal(
    "AudioContext",
    vi.fn(function () {
      return audioContext;
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function mount(path = "/guest/invitation.signature") {
  const view = render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/guest/:invitation?" element={<GuestRoute />} />
      </Routes>
    </MemoryRouter>,
  );
  await screen.findByRole("button", { name: /Join studio/ });
  return view;
}
async function ready() {
  await mount();
  fireEvent.click(screen.getByRole("button", { name: /Speaker test/ }));
  fireEvent.click(
    screen.getByRole("checkbox", { name: /I am wearing headphones/ }),
  );
}
async function join() {
  await ready();
  fireEvent.click(screen.getByRole("button", { name: /Join studio/ }));
  await screen.findByRole("button", { name: /Leave/ });
  await tick();
}
async function emit(event: string, ...args: any[]) {
  await act(async () => {
    handlers[event](...args);
    await Promise.resolve();
    await Promise.resolve();
  });
}
async function command(value: object) {
  await emit(
    "DataReceived",
    new TextEncoder().encode(JSON.stringify(value)),
    undefined,
    undefined,
    "alcantara-director",
  );
}
const acks = () =>
  requests.filter((request) => request.path.includes("/commands/"));

it("prepares devices and requires speaker and echo checks before any join request", async () => {
  await mount();
  expect(meta({} as any)).toEqual([{ title: "Guest Call - Alcántara" }]);
  expect(getUserMedia).toHaveBeenCalledWith({
    video: { width: { ideal: 1280 }, height: { ideal: 720 } },
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });
  expect(screen.getByText("Browser network check ready")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /Join studio/ })).toBeDisabled();
  fireEvent.click(
    screen.getByRole("checkbox", { name: /I am wearing headphones/ }),
  );
  expect(screen.getByRole("button", { name: /Join studio/ })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: /Speaker test/ }));
  expect(screen.getByRole("button", { name: /Join studio/ })).toBeEnabled();
  expect(oscillator.frequency.value).toBe(523.25);
  expect(oscillator.start).toHaveBeenCalledOnce();
  expect(oscillator.stop).toHaveBeenCalledWith(12.35);
  oscillator.addEventListener.mock.calls[0][1]();
  expect(audioContext.close).toHaveBeenCalledOnce();
  expect(requests).toEqual([]);
});
it("allows the explicitly accepted speaker-risk alternative to headphones", async () => {
  await mount();
  fireEvent.click(screen.getByRole("button", { name: /Speaker test/ }));
  fireEvent.click(
    screen.getByRole("checkbox", { name: /Operator accepted speaker risk/ }),
  );
  expect(screen.getByRole("button", { name: /Join studio/ })).toBeEnabled();
  fireEvent.click(
    screen.getByRole("checkbox", { name: /Operator accepted speaker risk/ }),
  );
  expect(screen.getByRole("button", { name: /Join studio/ })).toBeDisabled();
});
it.each([new Error("Permission denied"), "denied"])(
  "reports media permission rejection and leaves joining disabled (%s)",
  async (reason) => {
    getUserMedia.mockRejectedValue(reason);
    await mount();
    expect(screen.getByRole("alert")).toHaveTextContent(
      reason instanceof Error
        ? "Camera or microphone permission failed: Permission denied"
        : "Camera or microphone permission failed.",
    );
    expect(screen.getByRole("button", { name: /Join studio/ })).toBeDisabled();
    expect(requests).toEqual([]);
  },
);
it("stops media returned after the guest has navigated away", async () => {
  let resolve!: (stream: any) => void;
  getUserMedia.mockImplementation(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  const view = render(
    <MemoryRouter>
      <GuestRoute />
    </MemoryRouter>,
  );
  view.unmount();
  await act(async () => {
    resolve(stream);
  });
  expect(video.stop).toHaveBeenCalledOnce();
  expect(audio.stop).toHaveBeenCalledOnce();
});
it.each([{ effectiveType: "4g", downlink: 12, rtt: 20 }, {}])(
  "shows available browser network telemetry (%j)",
  async (connection) => {
    Object.defineProperty(navigator, "connection", {
      configurable: true,
      value: connection,
    });
    await mount();
    expect(
      screen.getByText(
        "effectiveType" in connection
          ? "4g · 12 Mbps · 20 ms RTT"
          : "network · ? Mbps · ? ms RTT",
      ),
    ).toBeInTheDocument();
  },
);
it("toggles the actual preview tracks before joining", async () => {
  const view = await mount();
  expect(view.container.querySelector("video")?.srcObject).toBe(stream);
  fireEvent.click(screen.getByRole("button", { name: /Camera on/ }));
  fireEvent.click(screen.getByRole("button", { name: /Mic on/ }));
  expect(video.enabled).toBe(false);
  expect(audio.enabled).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: /Camera off/ }));
  fireEvent.click(screen.getByRole("button", { name: /Mic off/ }));
  expect(video.enabled).toBe(true);
  expect(audio.enabled).toBe(true);
});
it("joins with the invitation and prior tab session, then starts bound telemetry", async () => {
  sessionStorage.setItem("alcantara-guest-session:invitation", "prior-session");
  await join();
  expect(requests[0]).toEqual({
    path: "/webrtc/join",
    body: { invitation: "invitation.signature", sessionToken: "prior-session" },
  });
  expect(room.connect).toHaveBeenCalledWith(
    credentials.serverUrl,
    credentials.token,
    { autoSubscribe: false },
  );
  expect(sessionStorage.getItem("alcantara-guest-session:invitation")).toBe(
    credentials.sessionToken,
  );
  expect(
    screen.getByText(
      "Invited guest · morning · program video · master mix-minus",
    ),
  ).toBeInTheDocument();
  expect(video.stop).toHaveBeenCalledOnce();
  expect(audio.stop).toHaveBeenCalledOnce();
  expect(room.localParticipant.setCameraEnabled).toHaveBeenCalledWith(true, {
    deviceId: "camera-one",
  });
  expect(room.localParticipant.setMicrophoneEnabled).toHaveBeenCalledWith(
    true,
    { deviceId: "microphone-one" },
  );
  expect(
    requests.find((request) => request.path.endsWith("/heartbeat"))?.body,
  ).toEqual({
    sessionToken: credentials.sessionToken,
    telemetry: {
      connectionState: "connected",
      quality: "unknown",
      returnFeedHealth: "missing",
      cameraEnabled: true,
      microphoneEnabled: true,
    },
  });
  await act(async () => {
    interval!();
  });
  expect(
    requests.filter((request) => request.path.endsWith("/heartbeat")),
  ).toHaveLength(2);
});
it.each(["json", "plain", "empty", "unstructured-json"])(
  "preserves a rejected join error (%s)",
  async (kind) => {
    joinResponse = async () =>
      kind === "json"
        ? Response.json({ message: "Invitation revoked" }, { status: 403 })
        : new Response(
            kind === "plain"
              ? "Studio unavailable"
              : kind === "unstructured-json"
                ? "{}"
                : "",
            { status: 503 },
          );
    await ready();
    fireEvent.click(screen.getByRole("button", { name: /Join studio/ }));
    await screen.findByRole("alert");
    expect(screen.getByRole("alert")).toHaveTextContent(
      kind === "json"
        ? "Invitation revoked"
        : kind === "plain"
          ? "Studio unavailable"
          : kind === "unstructured-json"
            ? "{}"
            : "Request failed (503)",
    );
    expect(room.connect).not.toHaveBeenCalled();
    expect(interval).toBeUndefined();
  },
);
it.each([new Error("Room unavailable"), "transport unavailable"])(
  "reports a room connection failure (%s)",
  async (reason) => {
    room.connect.mockRejectedValue(reason);
    await ready();
    fireEvent.click(screen.getByRole("button", { name: /Join studio/ }));
    await screen.findByRole("alert");
    expect(screen.getByRole("alert")).toHaveTextContent(
      reason instanceof Error
        ? "Room unavailable"
        : "Unable to join the studio.",
    );
  },
);
it("leaves and stops telemetry without another join or heartbeat", async () => {
  await join();
  fireEvent.click(screen.getByRole("button", { name: /Leave/ }));
  expect(room.disconnect).toHaveBeenCalledOnce();
  expect(window.clearInterval).toHaveBeenCalledWith(7);
  expect(screen.getByText("You left the studio.")).toBeInTheDocument();
});
it.each([401, 403])(
  "ends a revoked session when heartbeat returns %s",
  async (status) => {
    heartbeatStatus = status;
    await ready();
    fireEvent.click(screen.getByRole("button", { name: /Join studio/ }));
    await screen.findByText("The studio session ended.");
    expect(screen.getByRole("alert")).toHaveTextContent(
      "The studio ended or revoked this guest session.",
    );
    expect(room.disconnect).toHaveBeenCalled();
    expect(window.clearInterval).toHaveBeenCalledWith(7);
  },
);
it("reconciles reconnecting, connected and disconnected room events", async () => {
  await join();
  await emit("ConnectionStateChanged", "reconnecting");
  expect(screen.getByText("reconnecting")).toBeInTheDocument();
  await emit("ConnectionStateChanged", "connected");
  expect(screen.getByText("live")).toBeInTheDocument();
  await emit("ConnectionStateChanged", "disconnected");
  expect(screen.getByText("The studio session ended.")).toBeInTheDocument();
});
it("routes only selected program video and guest-specific mix-minus audio", async () => {
  await join();
  const publication = (kind: string, trackName = "") => ({
    kind,
    trackName,
    setSubscribed: vi.fn(),
  });
  const selected = publication("video");
  const preview = publication("video");
  const stranger = publication("audio", "mixminus:guest-one:master");
  const mixminus = publication("audio", "mixminus:guest-one:master");
  const otherGuest = publication("audio", "mixminus:guest-two:master");
  await emit("TrackPublished", selected, { identity: "program-feed-morning" });
  await emit("TrackPublished", preview, { identity: "preview-feed-morning" });
  await emit("TrackPublished", stranger, { identity: "unrelated" });
  await emit("TrackPublished", mixminus, { identity: "return-router-a" });
  await emit("TrackPublished", otherGuest, { identity: "return-router-a" });
  expect(selected.setSubscribed).toHaveBeenCalledWith(true);
  for (const unwanted of [preview, stranger, otherGuest])
    expect(unwanted.setSubscribed).toHaveBeenCalledWith(false);
  expect(mixminus.setSubscribed).toHaveBeenCalledWith(true);
  const track = { kind: "video", attach: vi.fn(), detach: vi.fn() };
  await emit("TrackSubscribed", track, selected, {
    identity: "program-feed-morning",
  });
  expect(track.attach).toHaveBeenCalledWith(expect.any(HTMLVideoElement));
  expect(
    screen.queryByText("Waiting for selected return feed"),
  ).not.toBeInTheDocument();
  const sound = { kind: "audio", attach: vi.fn(), detach: vi.fn() };
  await emit("TrackSubscribed", sound, mixminus, {
    identity: "return-router-a",
  });
  expect(sound.attach).toHaveBeenCalledWith(expect.any(HTMLAudioElement));
  expect(HTMLMediaElement.prototype.play).toHaveBeenCalledOnce();
  const unwanted = { kind: "video", attach: vi.fn() };
  await emit("TrackSubscribed", unwanted, preview, {
    identity: "preview-feed-morning",
  });
  expect(unwanted.attach).not.toHaveBeenCalled();
  await emit("TrackUnsubscribed", track);
  expect(track.detach).toHaveBeenCalledOnce();
  expect(
    screen.getByText("Waiting for selected return feed"),
  ).toBeInTheDocument();
});
it("handles studio media-disable commands and asks before enabling devices", async () => {
  await join();
  await command({
    id: "disable-camera",
    type: "media",
    device: "camera",
    enabled: false,
  });
  expect(room.localParticipant.setCameraEnabled).toHaveBeenLastCalledWith(
    false,
  );
  expect(
    screen.getByRole("button", { name: /Camera off/ }),
  ).toBeInTheDocument();
  await command({
    id: "disable-mic",
    type: "media",
    device: "microphone",
    enabled: false,
  });
  expect(screen.getByRole("button", { name: /Mic off/ })).toBeInTheDocument();
  await command({
    id: "enable-camera",
    type: "media",
    device: "camera",
    enabled: true,
  });
  expect(screen.getByText("Studio requests your camera.")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Accept" }));
  await screen.findByRole("button", { name: /Camera on/ });
  await command({
    id: "enable-mic",
    type: "media",
    device: "microphone",
    enabled: true,
  });
  fireEvent.click(screen.getByRole("button", { name: "Decline" }));
  await waitFor(() =>
    expect(
      screen.queryByText("Studio requests your microphone."),
    ).not.toBeInTheDocument(),
  );
  expect(acks().map((request) => request.body.status)).toEqual([
    "accepted",
    "accepted",
    "accepted",
    "rejected",
  ]);
  expect(room.localParticipant.setMicrophoneEnabled).toHaveBeenLastCalledWith(
    false,
  );
});
it("accepts microphone enable requests and acknowledges cues and messages", async () => {
  await join();
  await command({
    id: "enable-mic",
    type: "media",
    device: "microphone",
    enabled: true,
  });
  fireEvent.click(screen.getByRole("button", { name: "Accept" }));
  await waitFor(() => expect(acks()).toHaveLength(1));
  expect(room.localParticipant.setMicrophoneEnabled).toHaveBeenLastCalledWith(
    true,
  );
  await command({ id: "cue / one", type: "cue", cue: "Stand by" });
  expect(screen.getByText("Stand by")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /Acknowledge/ }));
  await waitFor(() => expect(acks()).toHaveLength(2));
  expect(acks()[1].path).toBe("/webrtc/commands/cue%20%2F%20one/ack");
  await command({ id: "message", type: "message", text: "Studio message" });
  expect(acks().at(-1)?.body.status).toBe("read");
  expect(acks().at(-1)?.body.sessionToken).toBe(credentials.sessionToken);
});
it("ignores unrelated or malformed room data and applies return selections", async () => {
  await join();
  await emit(
    "DataReceived",
    new TextEncoder().encode("{"),
    null,
    null,
    "other-topic",
  );
  await emit(
    "DataReceived",
    new TextEncoder().encode("{"),
    null,
    null,
    "alcantara-director",
  );
  await command({ type: "cue", cue: "Unidentified command" });
  expect(screen.queryByText("Unidentified command")).not.toBeInTheDocument();
  await command({
    id: "return",
    type: "return",
    returnVideo: "preview",
    returnAudioBus: "aux",
  });
  expect(
    screen.getByText("Invited guest · morning · preview video · aux mix-minus"),
  ).toBeInTheDocument();
  await command({ id: "empty-return", type: "return" });
  expect(acks()).toEqual([]);
});
it("updates connected device states and disconnects the room on navigation", async () => {
  const view = await mount();
  fireEvent.click(screen.getByRole("button", { name: /Speaker test/ }));
  fireEvent.click(
    screen.getByRole("checkbox", { name: /I am wearing headphones/ }),
  );
  fireEvent.click(screen.getByRole("button", { name: /Join studio/ }));
  await screen.findByRole("button", { name: /Leave/ });
  fireEvent.click(screen.getByRole("button", { name: /Camera on/ }));
  fireEvent.click(screen.getByRole("button", { name: /Mic on/ }));
  await tick();
  expect(room.localParticipant.setCameraEnabled).toHaveBeenLastCalledWith(
    false,
  );
  expect(room.localParticipant.setMicrophoneEnabled).toHaveBeenLastCalledWith(
    false,
  );
  view.unmount();
  expect(room.disconnect).toHaveBeenCalledOnce();
  expect(window.clearInterval).toHaveBeenCalledWith(7);
});

it("joins without fabricated device constraints when the browser exposes no device identifiers", async () => {
  stream.getVideoTracks = () => [];
  stream.getAudioTracks = () => [];
  devices = [];
  await join();
  expect(room.localParticipant.setCameraEnabled).toHaveBeenCalledWith(
    true,
    undefined,
  );
  expect(room.localParticipant.setMicrophoneEnabled).toHaveBeenCalledWith(
    true,
    undefined,
  );
});
it("uses enumerated device identifiers when media track settings are absent", async () => {
  video.getSettings = () => ({});
  audio.getSettings = () => ({});
  await join();
  expect(room.localParticipant.setCameraEnabled).toHaveBeenCalledWith(true, {
    deviceId: "camera-one",
  });
  expect(room.localParticipant.setMicrophoneEnabled).toHaveBeenCalledWith(
    true,
    { deviceId: "microphone-one" },
  );
});
it("subscribes existing participant publications after connection and disables return video when none is selected", async () => {
  const publication = { kind: "video", setSubscribed: vi.fn() };
  const mixminus = {
    kind: "audio",
    trackName: "mixminus:guest-one:master",
    setSubscribed: vi.fn(),
  };
  room.remoteParticipants.set("feed", {
    identity: "program-feed-morning",
    trackPublications: new Map([
      ["video", publication],
      ["audio", mixminus],
    ]),
  });
  joinResponse = async () =>
    Response.json({ ...credentials, returnVideo: "none" });
  await join();
  expect(publication.setSubscribed).toHaveBeenCalledWith(false);
  expect(mixminus.setSubscribed).toHaveBeenCalledWith(true);
});
it("joins from an invitation-less route under the explicit unknown tab session key", async () => {
  sessionStorage.setItem("alcantara-guest-session:unknown", "previous-unknown");
  await mount("/guest");
  fireEvent.click(screen.getByRole("button", { name: /Speaker test/ }));
  fireEvent.click(
    screen.getByRole("checkbox", { name: /I am wearing headphones/ }),
  );
  fireEvent.click(screen.getByRole("button", { name: /Join studio/ }));
  await screen.findByRole("button", { name: /Leave/ });
  expect(requests[0].body).toEqual({
    invitation: "",
    sessionToken: "previous-unknown",
  });
  expect(sessionStorage.getItem("alcantara-guest-session:unknown")).toBe(
    credentials.sessionToken,
  );
});
it("does not enable a media request that omits the requested device", async () => {
  await join();
  await command({ id: "missing-device", type: "media", enabled: true });
  fireEvent.click(screen.getByRole("button", { name: "Accept" }));
  await tick();
  expect(screen.getByRole("button", { name: "Accept" })).toBeInTheDocument();
  expect(acks()).toEqual([]);
  expect(room.localParticipant.setCameraEnabled).toHaveBeenCalledTimes(1);
});
