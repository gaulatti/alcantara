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
  },
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
