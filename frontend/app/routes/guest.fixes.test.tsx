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

// The guest page after a refused join and after a director message: a guest
// can retry a join the studio may still accept, a revoked or expired
// invitation ends the session, and a message stays until the guest
// acknowledges it. LiveKit, media devices and Web Audio are stand-ins.

const lk = vi.hoisted(() => {
  type Handler = (...args: unknown[]) => void;
  const state = {
    rooms: [] as InstanceType<typeof Room>[],
    connectError: null as unknown,
  };
  class Room {
    handlers = new Map<string, Handler>();
    remoteParticipants = new Map();
    disconnected = false;
    localParticipant = {
      setCameraEnabled: async () => undefined,
      setMicrophoneEnabled: async () => undefined,
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
      if (state.connectError) throw state.connectError;
    }
    disconnect() {
      this.disconnected = true;
      // A real room reports its own disconnect to whoever still listens.
      this.emit("connectionStateChanged", "disconnected");
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

const joined = () =>
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

let joinAnswers: Array<() => Response | Promise<Response>>;
let getUserMedia: ReturnType<typeof vi.fn>;
let acks: string[];

beforeEach(() => {
  lk.state.rooms = [];
  lk.state.connectError = null;
  joinAnswers = [];
  acks = [];
  window.sessionStorage.clear();
  getUserMedia = vi.fn(async () => mediaStream());
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia, enumerateDevices: vi.fn(async () => []) },
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
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/webrtc/join"))
        return (joinAnswers.shift() ?? joined)();
      if (url.endsWith("/webrtc/session/heartbeat"))
        return new Response(null, { status: 200 });
      if (url.includes("/webrtc/commands/")) {
        acks.push(
          (JSON.parse(String(init?.body)) as { status: string }).status,
        );
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

const joinButton = () => screen.getByRole("button", { name: /Join studio/ });

async function preflight() {
  expect(await screen.findByText("Browser network check ready")).toBeVisible();
  fireEvent.click(screen.getByText("Speaker test").closest("button")!);
  fireEvent.click(screen.getByLabelText(/I am wearing headphones/));
  expect(joinButton()).toBeEnabled();
}

const live = () =>
  screen.findByText("Ada · main · program video · aux-2 mix-minus");

it("lets the guest join again after another window held the invitation", async () => {
  joinAnswers = [
    () =>
      Response.json(
        { message: "This invitation is already active in another session." },
        { status: 409 },
      ),
  ];
  openPage();
  await preflight();
  fireEvent.click(joinButton());
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "This invitation is already in use in another window. Try again in a minute.",
  );
  expect(joinButton()).toBeEnabled();

  fireEvent.click(joinButton());
  expect(await live()).toBeVisible();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it.each([
  [401, "This invitation expired."],
  [403, "This invitation was revoked."],
])(
  "ends the session when the studio refuses the join with %i",
  async (status, message) => {
    joinAnswers = [() => Response.json({ message }, { status })];
    openPage();
    await preflight();
    fireEvent.click(joinButton());
    expect(await screen.findByText("The studio session ended.")).toBeVisible();
    expect(screen.getByRole("alert")).toHaveTextContent(message);
    // The join itself was refused, so the invitation is closed: say what to do, once, and offer no
    // rejoin that can only fail again (gaulatti/alcantara#353).
    expect(screen.getByRole("alert")).toHaveTextContent("Ask the studio for a new link.");
    expect(screen.getAllByText(new RegExp(message.replace(".", "\\.")))).toHaveLength(1);
    expect(
      screen.queryByRole("button", { name: "Rejoin the studio" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Join studio/ }),
    ).not.toBeInTheDocument();
  },
);

it.each([
  [
    "the studio is not configured",
    () =>
      Response.json({ message: "WebRTC is not configured." }, { status: 503 }),
    "The studio is not ready for guests yet. Try again in a minute.",
  ],
  [
    "the network is down",
    () => Promise.reject(new TypeError("Failed to fetch")),
    "The studio could not be reached. Check your connection and try again.",
  ],
  [
    "another refusal carries its own message",
    () => Response.json({ message: "Guest slot 3 is busy." }, { status: 400 }),
    "Guest slot 3 is busy.",
  ],
])("can retry when %s", async (_case, answer, message) => {
  joinAnswers = [answer];
  openPage();
  await preflight();
  fireEvent.click(joinButton());
  expect(await screen.findByRole("alert")).toHaveTextContent(message);
  expect(joinButton()).toBeEnabled();
  fireEvent.click(joinButton());
  expect(await live()).toBeVisible();
});

it("releases the half-joined room and can retry after the room connection fails", async () => {
  lk.state.connectError = new Error("could not establish signal connection");
  openPage();
  await preflight();
  fireEvent.click(joinButton());
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Could not connect to the studio. Try again.",
  );
  // The failed room is closed without its disconnect ending the session.
  expect(lk.state.rooms[0].disconnected).toBe(true);
  expect(
    screen.queryByText("The studio session ended."),
  ).not.toBeInTheDocument();
  expect(joinButton()).toBeEnabled();
  lk.state.connectError = null;
  fireEvent.click(joinButton());
  expect(await live()).toBeVisible();
  expect(lk.state.rooms).toHaveLength(2);
  expect(lk.state.rooms[1].disconnected).toBe(false);
});

it("can retry when the studio's join answer cannot be read", async () => {
  joinAnswers = [() => new Response("not json", { status: 200 })];
  openPage();
  await preflight();
  fireEvent.click(joinButton());
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Could not connect to the studio. Try again.",
  );
  expect(lk.state.rooms).toHaveLength(0);
  fireEvent.click(joinButton());
  expect(await live()).toBeVisible();
});

it("keeps the join locked when the camera or microphone is refused", async () => {
  getUserMedia.mockRejectedValueOnce(new Error("Permission denied"));
  openPage();
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Camera or microphone permission failed: Permission denied",
  );
  fireEvent.click(screen.getByText("Speaker test").closest("button")!);
  fireEvent.click(screen.getByLabelText(/I am wearing headphones/));
  expect(joinButton()).toBeDisabled();
});

it("keeps a director message on screen until the guest acknowledges it", async () => {
  openPage();
  await preflight();
  fireEvent.click(joinButton());
  await live();
  const room = lk.state.rooms.at(-1)!;
  act(() =>
    room.emit(
      "dataReceived",
      new TextEncoder().encode(
        JSON.stringify({ id: "c7", type: "message", text: "You are on in 10" }),
      ),
      undefined,
      undefined,
      "alcantara-director",
    ),
  );
  await waitFor(() => expect(acks).toEqual(["read"]));
  // The read receipt has been answered; the message is still there.
  expect(screen.getByText("You are on in 10")).toBeVisible();

  fireEvent.click(screen.getByRole("button", { name: /Acknowledge/ }));
  await waitFor(() =>
    expect(screen.queryByText("You are on in 10")).not.toBeInTheDocument(),
  );
  expect(acks).toEqual(["read", "acknowledged"]);
});
