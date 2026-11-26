import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import GuestRoute from "./guest";

// gaulatti/alcantara#672: every heartbeat reports the call as it is now (camera, microphone, connection quality
// and return feed), not as it was when the guest joined; a rejoin starts from the new room. A director media
// command that names no device is ignored, and the guest's own Acknowledge clears a message even when no receipt
// can be sent.

const lk = vi.hoisted(() => {
  type Handler = (...args: unknown[]) => void;
  const state = { rooms: [] as InstanceType<typeof Room>[] };
  class Room {
    state = "disconnected";
    handlers = new Map<string, Handler>();
    remoteParticipants = new Map();
    calls: string[] = [];
    localParticipant = {
      setCameraEnabled: async (enabled: boolean) => {
        this.calls.push(`camera:${enabled}`);
      },
      setMicrophoneEnabled: async (enabled: boolean) => {
        this.calls.push(`microphone:${enabled}`);
      },
      getTrackPublication: () => undefined,
    };
    constructor() {
      state.rooms.push(this);
    }
    on(event: string, handler: Handler) {
      this.handlers.set(event, handler);
      return this;
    }
    emit(event: string, ...args: unknown[]) {
      this.handlers.get(event)?.(...args);
    }
    async connect() {
      this.state = "connected";
    }
    disconnect() {
      this.state = "disconnected";
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
    ConnectionQualityChanged: "connectionQualityChanged",
    DataReceived: "dataReceived",
    Disconnected: "disconnected",
  },
  DisconnectReason: { CLIENT_INITIATED: 1, DUPLICATE_IDENTITY: 2, PARTICIPANT_REMOVED: 4, ROOM_DELETED: 5 },
  Track: {
    Kind: { Video: "video", Audio: "audio" },
    Source: { Camera: "camera" },
  },
}));

const track = () => ({
  enabled: true,
  stop() {},
  getSettings: () => ({}),
});
const mediaStream = () => {
  const video = [track()];
  const audio = [track()];
  return {
    getVideoTracks: () => video,
    getAudioTracks: () => audio,
    getTracks: () => [...video, ...audio],
  };
};

type Telemetry = {
  connectionState: string;
  quality: string;
  returnFeedHealth: string;
  cameraEnabled: boolean;
  microphoneEnabled: boolean;
};

let sessionToken: string;
let heartbeats: Telemetry[];
let receipts: string[];
let scheduledHeartbeats: Array<() => void>;

beforeEach(() => {
  lk.state.rooms = [];
  sessionToken = "session-1";
  heartbeats = [];
  receipts = [];
  scheduledHeartbeats = [];
  window.sessionStorage.clear();
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      getUserMedia: vi.fn(async () => mediaStream()),
      enumerateDevices: vi.fn(async () => []),
    },
  });
  Object.defineProperty(navigator, "connection", {
    configurable: true,
    value: undefined,
  });
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
  vi.stubGlobal(
    "AudioContext",
    class {
      currentTime = 0;
      destination = {};
      createOscillator() {
        return {
          frequency: { value: 0 },
          connect: (next: unknown) => next,
          start() {},
          stop() {},
          addEventListener() {},
        };
      }
      createGain() {
        return { gain: { value: 0 }, connect: (next: unknown) => next };
      }
      async close() {}
    },
  );
  // The 20-second heartbeat is kept for the test to run; every other interval runs as usual.
  const realSetInterval = window.setInterval.bind(window);
  vi.spyOn(window, "setInterval").mockImplementation(((
    handler: () => void,
    delay?: number,
  ) => {
    if (delay === 20_000) {
      scheduledHeartbeats.push(handler);
      return 0;
    }
    return realSetInterval(handler, delay);
  }) as typeof window.setInterval);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      if (url.endsWith("/webrtc/join"))
        return Response.json({
          serverUrl: "wss://livekit.example",
          token: "fictional-guest-token",
          sessionToken,
          displayName: "Ada",
          programId: "main",
          participantIdentity: "guest-ada",
          returnVideo: "program",
          returnAudioBus: "aux-2",
        });
      if (url.endsWith("/webrtc/session/heartbeat")) {
        heartbeats.push((body as { telemetry: Telemetry }).telemetry);
        return new Response(null, { status: 200 });
      }
      if (url.includes("/webrtc/commands/")) {
        receipts.push((body as { status: string }).status);
        return new Response(null, { status: 204 });
      }
      throw new Error(`unexpected ${url}`);
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function openPage() {
  render(
    <MemoryRouter initialEntries={["/guest/inv-1.secret"]}>
      <Routes>
        <Route path="/guest/:invitation" element={<GuestRoute />} />
      </Routes>
    </MemoryRouter>,
  );
}

const room = () => lk.state.rooms.at(-1)!;
const emit = (event: string, ...args: unknown[]) =>
  act(() => room().emit(event, ...args));
const director = (command: Record<string, unknown>) =>
  emit(
    "dataReceived",
    new TextEncoder().encode(JSON.stringify(command)),
    undefined,
    undefined,
    "alcantara-director",
  );
const live = () =>
  screen.findByText("Ada · main · program video · aux-2 mix-minus");

async function join() {
  openPage();
  expect(await screen.findByText("Browser network check ready")).toBeVisible();
  fireEvent.click(screen.getByText("Speaker test").closest("button")!);
  fireEvent.click(screen.getByLabelText(/I am wearing headphones/));
  fireEvent.click(screen.getByRole("button", { name: /Join studio/ }));
  await live();
  await waitFor(() => expect(heartbeats).toHaveLength(1));
}

// The return mix-minus arrives: the guest now hears the studio.
const returnAudioArrives = () =>
  emit(
    "trackSubscribed",
    { kind: "audio", attach() {}, detach() {} },
    { kind: "audio", trackName: "mixminus:guest-ada:aux-2" },
    { identity: "return-router-1" },
  );

async function nextHeartbeat() {
  const sent = heartbeats.length;
  await act(async () => {
    scheduledHeartbeats.at(-1)!();
  });
  await waitFor(() => expect(heartbeats).toHaveLength(sent + 1));
  return heartbeats.at(-1)!;
}

it("reports the camera, microphone, quality and return feed as they are now in every interval heartbeat", async () => {
  await join();
  expect(heartbeats[0]).toEqual({
    joined: true,
    connectionState: "connected",
    quality: "unknown",
    returnFeedHealth: "missing",
    cameraEnabled: true,
    microphoneEnabled: true,
  });

  fireEvent.click(screen.getByRole("button", { name: /Camera on/ }));
  fireEvent.click(screen.getByRole("button", { name: /Mic on/ }));
  await screen.findByRole("button", { name: /Mic off/ });
  await emit("connectionQualityChanged", "EXCELLENT", { isLocal: true });
  await returnAudioArrives();

  expect(await nextHeartbeat()).toEqual({
    connectionState: "connected",
    quality: "excellent",
    returnFeedHealth: "healthy",
    cameraEnabled: false,
    microphoneEnabled: false,
  });
});

it("reports a camera turned off by the director in the next heartbeat", async () => {
  await join();
  await director({ id: "c1", type: "media", device: "camera", enabled: false });
  await screen.findByRole("button", { name: /Camera off/ });
  expect((await nextHeartbeat()).cameraEnabled).toBe(false);
});

it("starts a rejoin's heartbeats from the new room, without the last room's feed or quality", async () => {
  await join();
  await emit("connectionQualityChanged", "GOOD", { isLocal: true });
  await returnAudioArrives();
  expect((await nextHeartbeat()).returnFeedHealth).toBe("healthy");

  await emit("connectionStateChanged", "disconnected");
  fireEvent.click(
    await screen.findByRole("button", { name: "Rejoin the studio" }),
  );
  await live();
  await waitFor(() => expect(heartbeats).toHaveLength(3));
  expect(heartbeats[2]).toMatchObject({
    quality: "unknown",
    returnFeedHealth: "missing",
  });
  // The new room waits for its own return feed.
  expect(screen.getByText("Waiting for selected return feed")).toBeVisible();
});

it("ignores a director media command that names no device", async () => {
  await join();
  const before = room().calls.length;
  await director({ id: "c2", type: "media", enabled: true });
  await director({ id: "c3", type: "media", enabled: false });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  expect(screen.queryByText(/Studio requests your/)).toBeNull();
  expect(screen.getByRole("button", { name: /Mic on/ })).toBeVisible();
  expect(screen.getByRole("button", { name: /Camera on/ })).toBeVisible();
  expect(room().calls).toHaveLength(before);
  expect(receipts).toEqual([]);
});

it("clears a director message on Acknowledge when there is no session to send a receipt for", async () => {
  sessionToken = "";
  openPage();
  expect(await screen.findByText("Browser network check ready")).toBeVisible();
  fireEvent.click(screen.getByText("Speaker test").closest("button")!);
  fireEvent.click(screen.getByLabelText(/I am wearing headphones/));
  fireEvent.click(screen.getByRole("button", { name: /Join studio/ }));
  await live();
  await director({ id: "c4", type: "message", text: "Fictional note" });
  expect(await screen.findByText("Fictional note")).toBeVisible();

  fireEvent.click(screen.getByRole("button", { name: /Acknowledge/ }));
  await waitFor(() =>
    expect(screen.queryByText("Fictional note")).not.toBeInTheDocument(),
  );
  // Still no heartbeat and no receipt without a session.
  expect(heartbeats).toEqual([]);
  expect(receipts).toEqual([]);
});

// gaulatti/alcantara#624 (guest.tsx:332): the shown program video leaves the room. The guest falls back to no feed and
// keeps the rest of the call; when a program video returns, it is shown again.
it("drops the shown program video when it leaves the room, and shows the next one that arrives", async () => {
  await join();
  const video = { kind: "video", attach() {}, detach() {} };
  const publication = { kind: "video", trackName: "program" };
  emit("trackSubscribed", video, publication, { identity: "program-feed-main" });
  await live();
  emit("trackUnsubscribed", video, publication, { identity: "program-feed-main" });
  expect(await live()).toBeVisible();
  const next = { kind: "video", attach() {}, detach() {} };
  emit("trackSubscribed", next, publication, { identity: "program-feed-main" });
  expect(await live()).toBeVisible();
});

// Call telemetry: the first heartbeat of a join says so, and every heartbeat names the ICE path when stats do.
it("says it joined once, with the ICE path from the published track's stats", async () => {
  const stats = new Map<string, Record<string, unknown>>([
    ["P", { type: "candidate-pair", localCandidateId: "L", nominated: true, state: "succeeded" }],
    ["L", { type: "local-candidate", candidateType: "relay", protocol: "udp" }],
  ]);
  const connect = lk.Room.prototype.connect;
  vi.spyOn(lk.Room.prototype, "connect").mockImplementation(async function (this: InstanceType<typeof lk.Room>) {
    Object.assign(this.localParticipant, {
      trackPublications: new Map([["camera", { track: { getRTCStatsReport: async () => stats } }]]),
    });
    await connect.call(this);
  });
  await join();
  expect(heartbeats[0]).toMatchObject({ joined: true, iceTransport: "relay" });
  const next = await nextHeartbeat();
  expect(next).toMatchObject({ iceTransport: "relay" });
  expect(next).not.toHaveProperty("joined");
});

it("tells the studio why the guest could not connect", async () => {
  vi.spyOn(lk.Room.prototype, "connect").mockRejectedValue(
    Object.assign(new Error("could not establish pc connection"), { name: "ConnectionError", reasonName: "InternalError" }),
  );
  openPage();
  expect(await screen.findByText("Browser network check ready")).toBeVisible();
  fireEvent.click(screen.getByText("Speaker test").closest("button")!);
  fireEvent.click(screen.getByLabelText(/I am wearing headphones/));
  fireEvent.click(screen.getByRole("button", { name: /Join studio/ }));
  await waitFor(() => expect(reportedFailures()).toEqual([{ invitation: "inv-1.secret", reason: "ice_failed" }]));
});

it("tells the studio when the browser refuses the camera and microphone", async () => {
  vi.mocked(navigator.mediaDevices.getUserMedia).mockRejectedValue(Object.assign(new Error("denied"), { name: "NotAllowedError" }));
  openPage();
  await waitFor(() => expect(reportedFailures()).toEqual([{ invitation: "inv-1.secret", reason: "permission_denied" }]));
});

it("reports a lost call with the first heartbeat that gets through, and no call the studio ended", async () => {
  await join();
  await emit("disconnected", 4);
  expect(await nextHeartbeat()).not.toHaveProperty("dropped");

  const answer = vi.mocked(fetch).getMockImplementation()!;
  vi.mocked(fetch).mockRejectedValueOnce(new Error("offline"));
  await emit("disconnected", 9);
  vi.mocked(fetch).mockImplementation(answer);
  expect(await nextHeartbeat()).toMatchObject({ dropped: true });
  expect(await nextHeartbeat()).not.toHaveProperty("dropped");
});

it("says the guest left, on Leave and when the page closes", async () => {
  await join();
  window.dispatchEvent(new Event("pagehide"));
  await waitFor(() => expect(heartbeats.at(-1)).toEqual({ left: true }));
  const sent = heartbeats.length;
  fireEvent.click(screen.getByRole("button", { name: /Leave/ }));
  await waitFor(() => expect(heartbeats).toHaveLength(sent + 1));
  expect(heartbeats.at(-1)).toEqual({ left: true });
});

const reportedFailures = () =>
  vi
    .mocked(fetch)
    .mock.calls.filter(([url]) => String(url).endsWith("/webrtc/join/failure"))
    .map(([, init]) => JSON.parse(String(init!.body)));
