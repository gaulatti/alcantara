import { act, cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ReturnRouterRoute, { meta } from "./return-router";

// The machine-only return router: it joins the program's LiveKit room as the
// renderer and publishes one N-1 mix per connected guest. LiveKit and Web
// Audio are stand-ins that record every connection the page makes.

const lk = vi.hoisted(() => {
  type Handler = (...args: unknown[]) => void;
  class FakeRoom {
    static last: FakeRoom | null = null;
    state = "disconnected";
    handlers = new Map<string, Handler>();
    remoteParticipants = new Map<string, { identity: string }>();
    published: { name: string; track: unknown }[] = [];
    unpublished: unknown[] = [];
    disconnected = false;
    localParticipant = {
      publishTrack: async (track: unknown, options: { name: string }) => {
        this.published.push({ name: options.name, track });
      },
      unpublishTrack: async (track: unknown) => {
        this.unpublished.push(track);
      },
    };
    constructor() {
      FakeRoom.last = this;
    }
    on(event: string, handler: Handler) {
      this.handlers.set(event, handler);
      return this;
    }
    emit(event: string, ...args: unknown[]) {
      this.handlers.get(event)?.(...args);
    }
    async connect(url: string, token: string) {
      this.connectedWith = { url, token };
      this.state = "connected";
    }
    connectedWith: { url: string; token: string } | null = null;
    disconnect() {
      this.disconnected = true;
    }
  }
  class FakeLocalAudioTrack {
    stopped = false;
    constructor(readonly mediaTrack: unknown) {}
    stop() {
      this.stopped = true;
    }
  }
  return { FakeRoom, FakeLocalAudioTrack };
});

vi.mock("livekit-client", () => ({
  Room: lk.FakeRoom,
  LocalAudioTrack: lk.FakeLocalAudioTrack,
  ConnectionState: { Connected: "connected" },
  RoomEvent: {
    TrackSubscribed: "trackSubscribed",
    TrackUnsubscribed: "trackUnsubscribed",
    ParticipantConnected: "participantConnected",
    ParticipantDisconnected: "participantDisconnected",
    Disconnected: "disconnected",
    Reconnecting: "reconnecting",
    Reconnected: "reconnected",
  },
  Track: {
    Kind: { Audio: "audio", Video: "video" },
    Source: { Microphone: "microphone" },
  },
}));

/** A Web Audio graph recorder: each node knows what it feeds. */
interface Node {
  label: string;
  feeds: Node[];
  disconnected: number;
  connect: (to: Node) => Node;
  disconnect: () => void;
}
let nodes: Node[] = [];
let meterLevel = 0;
let contextState = "running";
let resumes = 0;
let audioClosed = false;
function node(label: string, extra: Record<string, unknown> = {}): Node {
  const created: Node = {
    label,
    feeds: [],
    disconnected: 0,
    connect(to) {
      created.feeds.push(to);
      return to;
    },
    disconnect() {
      created.disconnected++;
      // As Web Audio does: a node that disconnects feeds nothing until it connects again.
      created.feeds = [];
    },
    ...extra,
  };
  nodes.push(created);
  return created;
}
class FakeAudioContext {
  createMediaStreamDestination() {
    const track = { id: `mixed-${nodes.length}` };
    return node("destination", {
      stream: { getAudioTracks: () => [track] },
    });
  }
  createMediaStreamSource(stream: { label: string }) {
    return node(`source:${stream.label}`);
  }
  createGain() {
    return node("gain", { gain: { value: 0 } });
  }
  createAnalyser() {
    return node("meter", {
      fftSize: 0,
      getFloatTimeDomainData: (buffer: Float32Array) => buffer.fill(meterLevel).fill(-meterLevel, 0, 1),
    });
  }
  state = contextState;
  createMediaElementSource(element: FakeAudio) {
    return node(`element:${element.src}`);
  }
  createDelay() {
    return node("delay", { delayTime: { value: -1 } });
  }
  async resume() {
    resumes += 1;
    // A suspended context that refuses to resume more than once (the page keeps asking, quietly).
    if (contextState === "suspended" && resumes > 1) throw new Error("refused");
  }
  async close() {
    audioClosed = true;
  }
}
/** The program-audio player: it records what it was asked to play and lets a test end or break the stream. */
class FakeAudio {
  static all: FakeAudio[] = [];
  src = "";
  srcObject: unknown = undefined;
  muted = false;
  crossOrigin: string | null = null;
  preload = "";
  paused = true;
  listeners = new Map<string, (event: { type: string }) => void>();
  error: { code: number } | null = null;
  static play: () => Promise<void> = () => Promise.resolve();
  constructor() {
    FakeAudio.all.push(this);
  }
  addEventListener(event: string, listener: (event: { type: string }) => void) {
    this.listeners.set(event, listener);
  }
  fire(event: string) {
    this.listeners.get(event)?.({ type: event });
  }
  play() {
    this.paused = false;
    return FakeAudio.play();
  }
  pause() {
    this.paused = true;
  }
  removeAttribute(name: string) {
    if (name === "src") this.src = "";
  }
  load() {}
}
class FakeMediaStream {
  label: string;
  constructor(tracks: { label: string }[]) {
    this.label = tracks[0].label;
  }
}

const room = () => lk.FakeRoom.last!;
/** Fires a room event as LiveKit would, letting React apply what it changes. */
const emit = (event: string, ...args: unknown[]) =>
  act(() => {
    room().emit(event, ...args);
  });
const sourceOf = (label: string) =>
  nodes.find((n) => n.label === `source:${label}`)!;
/** The guests' mixes, each as the list of what reaches its destination. */
function mixFor(guest: string) {
  // The live mix: a rebuild unpublishes the old track and publishes a new one.
  const published = room()
    .published.filter(
      (p) =>
        p.name.startsWith(`mixminus:${guest}:`) &&
        !room().unpublished.includes(p.track),
    )
    .at(-1)!;
  const destination = nodes.find(
    (n) =>
      n.label === "destination" &&
      (published.track as InstanceType<typeof lk.FakeLocalAudioTrack>)
        .mediaTrack ===
        (
          n as unknown as { stream: { getAudioTracks: () => unknown[] } }
        ).stream.getAudioTracks()[0],
  );
  return destination;
}

interface RouteState {
  participantIdentity: string;
  slotNumber: number;
  returnVideo: "program";
  returnAudioBus: string;
  sourceGain: number;
  sourceMuted: boolean;
  sourceDelayMs: number;
}
const guestRoute = (
  identity: string,
  overrides: Partial<RouteState> = {},
): RouteState => ({
  participantIdentity: identity,
  slotNumber: 1,
  returnVideo: "program",
  returnAudioBus: "program",
  sourceGain: 1,
  sourceMuted: false,
  sourceDelayMs: 0,
  ...overrides,
});

let routes: RouteState[] = [];
let tokenStatus = 200;
let stateStatus = 200;
let fetchCalls: { url: string; init: RequestInit }[] = [];
let audioTicket: () => Response = () => new Response(null, { status: 502 });

beforeEach(() => {
  vi.useFakeTimers();
  nodes = [];
  audioClosed = false;
  meterLevel = 0;
  contextState = "running";
  resumes = 0;
  lk.FakeRoom.last = null;
  routes = [];
  tokenStatus = 200;
  stateStatus = 200;
  fetchCalls = [];
  audioTicket = () => new Response(null, { status: 502 });
  FakeAudio.all = [];
  delete document.documentElement.dataset.returnRouter;
  delete document.documentElement.dataset.mixCount;
  window.sessionStorage.clear();
  vi.stubGlobal("Audio", FakeAudio);
  vi.stubGlobal("AudioContext", FakeAudioContext);
  vi.stubGlobal("MediaStream", FakeMediaStream);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init: RequestInit) => {
      const url = String(input);
      fetchCalls.push({ url, init });
      if (url.endsWith("/webrtc/renderer-token"))
        return tokenStatus === 200
          ? Response.json({
              serverUrl: "wss://livekit.example",
              token: "fictional-token",
            })
          : new Response(null, { status: tokenStatus });
      if (url.endsWith("/webrtc/return-audio-ticket")) return audioTicket();
      if (url.endsWith("/webrtc/renderer-state"))
        return stateStatus === 200
          ? Response.json({ routes })
          : new Response(null, { status: stateStatus });
      throw new Error(`unexpected ${url}`);
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

async function openRouter(
  hash = "#key=fictional-renderer-key",
  path = "/return-router/main",
) {
  window.history.replaceState(null, "", `${path}?view=1${hash}`);
  const view = render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route
          path="/return-router/:programId"
          element={<ReturnRouterRoute />}
        />
        <Route path="/return-router" element={<ReturnRouterRoute />} />
      </Routes>
    </MemoryRouter>,
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  return view;
}

const settle = () =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(150);
  });

function audioTrack(
  label: string,
  sid: string,
  name: string,
  identity: string,
) {
  return [
    { kind: "audio", mediaStreamTrack: { label } },
    { trackSid: sid, trackName: name },
    { identity },
  ] as const;
}

it("has a page title", () => {
  expect(meta()).toEqual([{ title: "Return Router - Alcántara" }]);
});

it("needs the renderer key from the URL fragment", async () => {
  await openRouter("");
  expect(
    screen.getByText("The return router could not start. Reload this page to try again. (start)"),
  ).toBeVisible();
  expect(fetchCalls).toHaveLength(0);
});

it("keeps the key for the session and takes it out of the address", async () => {
  tokenStatus = 401;
  await openRouter();
  expect(window.sessionStorage.getItem("alcantara-renderer-key")).toBe(
    "fictional-renderer-key",
  );
  expect(window.location.hash).toBe("");
  expect(window.location.search).toBe("?view=1");
  expect(
    screen.getByText("The return router could not start. Reload this page to try again. (start)"),
  ).toBeVisible();
  const token = fetchCalls[0];
  expect(new Headers(token.init.headers).get("X-Renderer-Key")).toBe(
    "fictional-renderer-key",
  );
  expect(JSON.parse(String(token.init.body))).toEqual({ programId: "main" });
});

it("reuses the key kept for the session, for the default program", async () => {
  window.sessionStorage.setItem("alcantara-renderer-key", "kept-key");
  tokenStatus = 403;
  await openRouter("", "/return-router");
  expect(new Headers(fetchCalls[0].init.headers).get("X-Renderer-Key")).toBe(
    "kept-key",
  );
  expect(JSON.parse(String(fetchCalls[0].init.body))).toEqual({
    programId: "main",
  });
});

it("explains routing state that cannot be read", async () => {
  stateStatus = 500;
  await openRouter();
  expect(screen.getByText("The return router could not start. Reload this page to try again. (start)")).toBeVisible();
});

it("explains a failure that is not an error object", async () => {
  // The room refuses the connection with a bare value.
  const original = lk.FakeRoom.prototype.connect;
  lk.FakeRoom.prototype.connect = async () => {
    throw "refused";
  };
  try {
    await openRouter();
  } finally {
    lk.FakeRoom.prototype.connect = original;
  }
  expect(screen.getByText("The return router could not start. Reload this page to try again. (start)")).toBeVisible();
});

// gaulatti/alexandria#9: the program bus takes one feed, the desktop's when it is in
// the room and Alana's otherwise, never both, switching both ways.
it("feeds the program bus from the desktop's feed while it is present, and from Alana's otherwise", async () => {
  routes = [guestRoute("guest-anna", { returnAudioBus: "program" })];
  await openRouter();
  await settle();
  room().remoteParticipants.set("guest-anna", { identity: "guest-anna" });
  emit("trackSubscribed", ...audioTrack("alana-feed", "t1", "program", "program-feed-main"));
  emit("trackSubscribed", ...audioTrack("anna-mic", "t2", "mic", "guest-anna"));
  await settle();
  expect(sourceOf("alana-feed").feeds).toContain(mixFor("guest-anna")!);

  // The desktop joins: its feed replaces Alana's on the bus.
  emit("trackSubscribed", ...audioTrack("desktop-feed", "t3", "program", "desktop-program-feed-main"));
  await settle();
  const withDesktop = mixFor("guest-anna")!;
  expect(sourceOf("desktop-feed").feeds).toContain(withDesktop);
  expect(sourceOf("alana-feed").feeds).not.toContain(withDesktop);

  // The desktop leaves: Alana's feed is back on the bus.
  emit("trackUnsubscribed", null, { trackSid: "t3" });
  await settle();
  expect(sourceOf("alana-feed").feeds).toContain(mixFor("guest-anna")!);
});

// The desktop console publishes the program's sound as a microphone-source track named
// "program-audio" (LiveKit's Swift SDK has no other kind of app-audio track). It is the program
// feed, never a guest's microphone: it reaches only guests on the program bus.
it("routes the desktop feed's program-audio to the program bus only, never as a guest microphone", async () => {
  routes = [
    guestRoute("guest-anna", { returnAudioBus: "program" }),
    guestRoute("guest-cy", { returnAudioBus: "monitor" }),
  ];
  await openRouter();
  await settle();
  room().remoteParticipants.set("guest-anna", { identity: "guest-anna" });
  room().remoteParticipants.set("guest-cy", { identity: "guest-cy" });
  emit("trackSubscribed", ...audioTrack("desktop-feed", "t1", "program-audio", "desktop-program-feed-main"));
  emit("trackSubscribed", ...audioTrack("anna-mic", "t2", "mic", "guest-anna"));
  emit("trackSubscribed", ...audioTrack("cy-mic", "t3", "mic", "guest-cy"));
  await settle();
  const anna = mixFor("guest-anna")!;
  const cy = mixFor("guest-cy")!;
  // Whether a source reaches a guest's mix by any path (direct, or through level and delay).
  const reaches = (from: Node, to: Node, seen = new Set<Node>()): boolean =>
    from === to || (!seen.has(from) && (seen.add(from), from.feeds.some((next) => reaches(next, to, seen))));
  expect(reaches(sourceOf("desktop-feed"), anna)).toBe(true);
  expect(reaches(sourceOf("desktop-feed"), cy)).toBe(false);
  // N-1 still holds: each guest hears the other's microphone, never its own.
  expect(reaches(sourceOf("anna-mic"), cy)).toBe(true);
  expect(reaches(sourceOf("cy-mic"), anna)).toBe(true);
  expect(reaches(sourceOf("cy-mic"), cy)).toBe(false);
});

it("publishes one N-1 mix per connected guest with each guest's own level and delay", async () => {
  routes = [
    guestRoute("guest-anna", {
      returnAudioBus: "program",
      sourceGain: 0.5,
      sourceDelayMs: 200,
    }),
    guestRoute("guest-bo", { returnAudioBus: "master", sourceMuted: true }),
    guestRoute("guest-cy", { returnAudioBus: "monitor" }),
  ];
  await openRouter();
  expect(room().connectedWith).toEqual({
    url: "wss://livekit.example",
    token: "fictional-token",
  });
  await settle();
  expect(
    screen.getByText("0 synchronized N-1 return mixes active"),
  ).toBeVisible();

  room().remoteParticipants.set("guest-anna", { identity: "guest-anna" });
  room().remoteParticipants.set("guest-bo", { identity: "guest-bo" });
  room().remoteParticipants.set("guest-dee", { identity: "guest-dee" });
  room().remoteParticipants.set("operator-1", { identity: "operator-1" });
  emit(
    "trackSubscribed",
    ...audioTrack("program-feed", "t1", "program", "program-feed-main"),
  );
  emit("trackSubscribed", ...audioTrack("anna-mic", "t2", "mic", "guest-anna"));
  emit("trackSubscribed", ...audioTrack("bo-mic", "t3", "mic", "guest-bo"));
  emit("trackSubscribed", ...audioTrack("dee-mic", "t4", "mic", "guest-dee"));
  emit(
    "trackSubscribed",
    ...audioTrack("talk-anna", "t5", "talkback:anna", "operator-1"),
  );
  emit(
    "trackSubscribed",
    ...audioTrack("talk-all", "t6", "talkback:all", "operator-1"),
  );
  emit(
    "trackSubscribed",
    ...audioTrack("talk-cy", "t7", "talkback:cy", "operator-1"),
  );
  // Video and tracks without media are not mixed.
  emit(
    "trackSubscribed",
    { kind: "video", mediaStreamTrack: {} },
    { trackSid: "v1" },
    { identity: "guest-anna" },
  );
  emit(
    "trackSubscribed",
    { kind: "audio", mediaStreamTrack: null },
    { trackSid: "a0" },
    { identity: "guest-anna" },
  );
  await settle();

  expect(
    screen.getByText("2 synchronized N-1 return mixes active"),
  ).toBeVisible();
  expect(
    room()
      .published.map((p) => p.name)
      .sort(),
  ).toEqual(["mixminus:guest-anna:program", "mixminus:guest-bo:master"]);

  // Anna hears the program bus and her talkback, not herself; Bo is muted.
  const anna = mixFor("guest-anna")!;
  expect(sourceOf("program-feed").feeds).toContain(anna);
  expect(sourceOf("talk-anna").feeds).toContain(anna);
  expect(sourceOf("talk-all").feeds).toContain(anna);
  expect(sourceOf("anna-mic").feeds).not.toContain(anna);
  // Bo's master return also takes the program feed, and Anna at her level and delay.
  const bo = mixFor("guest-bo")!;
  expect(sourceOf("program-feed").feeds).toContain(bo);
  const annaGain = sourceOf("anna-mic").feeds.find(
    (n) => n.label === "gain",
  ) as unknown as {
    gain: { value: number };
    feeds: Node[];
  };
  expect(annaGain.gain.value).toBe(0.5);
  const annaDelay = annaGain.feeds[0] as unknown as {
    delayTime: { value: number };
    feeds: Node[];
  };
  expect(annaDelay.delayTime.value).toBe(0.2);
  expect(annaDelay.feeds).toContain(bo);
  // A guest without a route reaches others at unity and no delay.
  const deeGain = sourceOf("dee-mic").feeds.find(
    (n) => n.label === "gain",
  ) as unknown as {
    gain: { value: number };
    feeds: { delayTime: { value: number } }[];
  };
  expect(deeGain.gain.value).toBe(1);
  expect(deeGain.feeds[0].delayTime.value).toBe(0);
  // Cy is not connected, so no mix is built for that route.
  expect(room().published.some((p) => p.name.includes("guest-cy"))).toBe(false);
});

it("rebuilds the mixes as tracks, guests and routes change", async () => {
  routes = [guestRoute("guest-anna")];
  await openRouter();
  room().remoteParticipants.set("guest-anna", { identity: "guest-anna" });
  emit("trackSubscribed", ...audioTrack("anna-mic", "t2", "mic", "guest-anna"));
  await settle();
  expect(
    screen.getByText("1 synchronized N-1 return mix active"),
  ).toBeVisible();
  const first = room().published[0].track as InstanceType<
    typeof lk.FakeLocalAudioTrack
  >;

  emit("trackUnsubscribed", {}, { trackSid: "t2" });
  emit("trackUnsubscribed", {}, { trackSid: "missing" });
  await settle();
  // A track that comes and goes rewires the mix behind the guest's return; the return itself is never replaced.
  expect(room().unpublished).not.toContain(first);
  expect(first.stopped).toBe(false);
  expect(room().published).toHaveLength(1);
  expect(sourceOf("anna-mic").disconnected).toBeGreaterThan(0);
  // The guest leaves: their return goes with them.
  room().remoteParticipants.delete("guest-anna");
  emit("participantDisconnected");
  await settle();
  expect(room().unpublished).toContain(first);
  expect(first.stopped).toBe(true);
  room().remoteParticipants.set("guest-anna", { identity: "guest-anna" });

  emit("reconnecting");
  expect(screen.getByText("Reconnecting return router…")).toBeVisible();
  emit("reconnected");
  emit("participantConnected");
  emit("participantDisconnected");
  await settle();
  expect(
    screen.getByText("1 synchronized N-1 return mix active"),
  ).toBeVisible();

  // Unchanged routes do not rebuild; changed routes do.
  const published = room().published.length;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(3000);
  });
  await settle();
  expect(room().published).toHaveLength(published);
  routes = [];
  await act(async () => {
    await vi.advanceTimersByTimeAsync(3000);
  });
  await settle();
  expect(
    screen.getByText("0 synchronized N-1 return mixes active"),
  ).toBeVisible();

  // A refresh failure is shown, whatever it is.
  stateStatus = 503;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(3000);
  });
  expect(screen.getByText("Route refresh failed; the last routes still apply. (route_refresh)")).toBeVisible();
  // The last good status stays visible beside the failure (gaulatti/alcantara#353).
  expect(screen.getByRole("status")).toHaveTextContent(/synchronized N-1 return mix/);
  vi.mocked(fetch).mockRejectedValueOnce("network down");
  await act(async () => {
    await vi.advanceTimersByTimeAsync(3000);
  });
  expect(screen.getByText("Route refresh failed; the last routes still apply. (route_refresh)")).toBeVisible();
});

it("does not mix while the room is disconnected, and reports a failed rebuild", async () => {
  routes = [guestRoute("guest-anna")];
  await openRouter();
  room().remoteParticipants.set("guest-anna", { identity: "guest-anna" });
  room().state = "reconnecting";
  emit("participantConnected");
  await settle();
  expect(room().published).toHaveLength(0);

  room().state = "connected";
  room().localParticipant.publishTrack = async () => {
    throw new Error("Publish refused");
  };
  emit("trackSubscribed", ...audioTrack("anna-mic", "t2", "mic", "guest-anna"));
  await settle();
  expect(screen.getByText("The mix could not be rebuilt. It retries when the room changes. (mix_rebuild)")).toBeVisible();

  room().localParticipant.publishTrack = async () => {
    throw "busy";
  };
  emit("participantConnected");
  await settle();
  expect(screen.getByText("The mix could not be rebuilt. It retries when the room changes. (mix_rebuild)")).toBeVisible();
  // A publish that failed is tried again at the next rebuild.
  room().localParticipant.publishTrack = async (_track: unknown, options: { name: string }) => {
    room().published.push({ name: options.name, track: _track });
  };
  emit("participantConnected");
  await settle();
  expect(room().published.map((p) => p.name)).toEqual(["mixminus:guest-anna:program"]);
});

it("keeps each guest's published return through rebuilds, and replaces it only when the guest changes bus", async () => {
  routes = [guestRoute("guest-anna", { returnAudioBus: "program" })];
  await openRouter();
  room().remoteParticipants.set("guest-anna", { identity: "guest-anna" });
  emit("participantConnected");
  await settle();
  emit("trackSubscribed", ...audioTrack("anna-mic", "t1", "mic", "guest-anna"));
  emit("trackSubscribed", ...audioTrack("alana-feed", "t2", "program", "program-feed-main"));
  emit("trackSubscribed", ...audioTrack("cy-mic", "t3", "mic", "guest-cy"));
  room().remoteParticipants.set("guest-cy", { identity: "guest-cy" });
  emit("participantConnected");
  await settle();
  expect(room().published.filter((p) => p.name === "mixminus:guest-anna:program")).toHaveLength(1);
  expect(room().unpublished).toHaveLength(0);
  routes = [guestRoute("guest-anna", { returnAudioBus: "monitor" })];
  await act(async () => {
    await vi.advanceTimersByTimeAsync(3_000);
  });
  await settle();
  expect(room().unpublished).toHaveLength(1);
  expect(room().published.at(-1)!.name).toBe("mixminus:guest-anna:monitor");
});

it("leaves the room and releases audio when the page closes", async () => {
  routes = [guestRoute("guest-anna")];
  const view = await openRouter();
  room().remoteParticipants.set("guest-anna", { identity: "guest-anna" });
  emit("trackSubscribed", ...audioTrack("anna-mic", "t2", "mic", "guest-anna"));
  await settle();
  const published = room().published[0].track;
  view.unmount();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(room().disconnected).toBe(true);
  expect(room().unpublished).toContain(published);
  expect(audioClosed).toBe(true);
  // A rebuild that was already scheduled does nothing after close.
  emit("participantConnected");
  await act(async () => {
    await vi.advanceTimersByTimeAsync(200);
  });
  expect(room().published).toHaveLength(1);
});

it("stops before publishing when the page closes during a rebuild", async () => {
  routes = [guestRoute("guest-anna")];
  const view = await openRouter();
  room().remoteParticipants.set("guest-anna", { identity: "guest-anna" });
  let release!: () => void;
  room().localParticipant.publishTrack = () =>
    new Promise<void>((resolve) => {
      release = resolve;
    });
  emit("trackSubscribed", ...audioTrack("anna-mic", "t2", "mic", "guest-anna"));
  await settle();
  view.unmount();
  await act(async () => {
    release();
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(screen.queryByText(/synchronized/)).not.toBeInTheDocument();
});

// The server-run return router (gaulatti/alcantara: calls work with nothing extra open).
describe("the server-run return router", () => {
  const grant = (path = "/radio/main/monitor-audio?ticket=fictional-ticket") => () =>
    Response.json({ streamPath: path, expiresInMs: 60000 });
  // The program-audio players (the keep-alive elements of remote tracks carry a srcObject instead).
  const players = () => FakeAudio.all.filter((audio) => audio.srcObject === undefined);
  const elementSource = () => nodes.find((n) => n.label.startsWith("element:"));

  it("asks for the program's fixed router identity only when the runner opened it", async () => {
    tokenStatus = 401;
    window.history.replaceState(null, "", "/");
    await openRouter("#key=fictional-renderer-key", "/return-router/main");
    expect(JSON.parse(String(fetchCalls[0].init.body))).toEqual({ programId: "main" });
    cleanup();
    fetchCalls = [];
    window.history.replaceState(null, "", "/return-router/main?runner=1#key=fictional-renderer-key");
    render(
      <MemoryRouter initialEntries={["/return-router/main"]}>
        <Routes>
          <Route path="/return-router/:programId" element={<ReturnRouterRoute />} />
        </Routes>
      </MemoryRouter>,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(JSON.parse(String(fetchCalls[0].init.body))).toEqual({ programId: "main", role: "return-router" });
    expect(document.documentElement.dataset.returnRouter).toBe("failed");
  });

  it("reports starting, then connected with the number of mixes it publishes", async () => {
    routes = [guestRoute("guest-anna")];
    await openRouter();
    expect(document.documentElement.dataset.returnRouter).toBe("starting");
    room().remoteParticipants.set("guest-anna", { identity: "guest-anna" });
    emit("participantConnected");
    await settle();
    expect(document.documentElement.dataset.returnRouter).toBe("connected");
    expect(document.documentElement.dataset.mixCount).toBe("1");
  });

  it("reports failed when LiveKit drops it, so the runner reopens it", async () => {
    await openRouter();
    await settle();
    emit("disconnected");
    expect(document.documentElement.dataset.returnRouter).toBe("failed");
  });

  it("mixes the program's own audio into the program bus while no program feed is in the room, never the guest's own voice", async () => {
    audioTicket = grant();
    routes = [guestRoute("guest-anna", { returnAudioBus: "master" }), guestRoute("guest-cy", { returnAudioBus: "monitor" })];
    await openRouter();
    await settle();
    const ticket = fetchCalls.find((call) => call.url.endsWith("/webrtc/return-audio-ticket"))!;
    expect(new Headers(ticket.init.headers).get("X-Renderer-Key")).toBe("fictional-renderer-key");
    expect(JSON.parse(String(ticket.init.body))).toEqual({ programId: "main" });
    expect(players()).toHaveLength(1);
    expect(players()[0].src).toContain("/radio/main/monitor-audio?ticket=fictional-ticket");
    expect(players()[0].crossOrigin).toBe("anonymous");
    expect(players()[0].paused).toBe(false);

    room().remoteParticipants.set("guest-anna", { identity: "guest-anna" });
    room().remoteParticipants.set("guest-cy", { identity: "guest-cy" });
    emit("trackSubscribed", ...audioTrack("anna-mic", "t1", "mic", "guest-anna"));
    await settle();
    expect(elementSource()!.feeds).toContain(mixFor("guest-anna")!);
    // Another bus does not take the program audio.
    expect(elementSource()!.feeds).not.toContain(mixFor("guest-cy")!);
    expect(sourceOf("anna-mic").feeds).not.toContain(mixFor("guest-anna")!);

    // A program feed joins: it is the program bus, and the fallback steps aside.
    emit("trackSubscribed", ...audioTrack("alana-feed", "t2", "program", "program-feed-main"));
    await settle();
    const withFeed = mixFor("guest-anna")!;
    expect(sourceOf("alana-feed").feeds).toContain(withFeed);
    expect(elementSource()!.feeds).not.toContain(withFeed);
  });

  it("refuses a grant that does not point at the program audio, and asks again later", async () => {
    audioTicket = grant("https://elsewhere.example/stream");
    await openRouter();
    await settle();
    expect(players()).toHaveLength(0);
    const asked = () => fetchCalls.filter((call) => call.url.endsWith("/webrtc/return-audio-ticket")).length;
    expect(asked()).toBe(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(asked()).toBe(2);
    // Then less often: 15 s, then every minute.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(asked()).toBe(3);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(59_000);
    });
    expect(asked()).toBe(3);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(asked()).toBe(4);
  });

  it("asks for the program audio again when the stream drops or cannot play, and stops it when the page closes", async () => {
    audioTicket = grant();
    routes = [guestRoute("guest-anna", { returnAudioBus: "program" })];
    const view = await openRouter();
    await settle();
    const first = players()[0];
    first.fire("playing");
    first.fire("ended");
    // A stale element's events change nothing.
    first.fire("error");
    expect(first.paused).toBe(true);
    expect(first.src).toBe("");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(players()).toHaveLength(2);
    const second = players()[1];
    second.fire("error");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(players()).toHaveLength(3);
    view.unmount();
    expect(players()[2].paused).toBe(true);
    expect(players()[2].src).toBe("");
  });

  it("drops the program audio and asks again when the browser refuses to play it", async () => {
    audioTicket = grant();
    FakeAudio.play = () => Promise.reject(new Error("autoplay refused"));
    try {
      await openRouter();
      await settle();
    } finally {
      FakeAudio.play = () => Promise.resolve();
    }
    expect(players()[0].src).toBe("");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(players()).toHaveLength(2);
  });

  it("does not start the program audio after the page has closed", async () => {
    let answer: (response: Response) => void = () => undefined;
    audioTicket = () => new Promise<Response>((resolve) => (answer = resolve)) as unknown as Response;
    const view = await openRouter();
    view.unmount();
    await act(async () => {
      answer(Response.json({ streamPath: "/radio/main/monitor-audio?ticket=late" }));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(players()).toHaveLength(0);
  });

  it("changes nothing once the page has closed: a late disconnect, a late refusal, or a connection that finishes late", async () => {
    let refuse: (response: Response) => void = () => undefined;
    audioTicket = () => new Promise<Response>((resolve) => (refuse = resolve)) as unknown as Response;
    const view = await openRouter();
    await settle();
    expect(document.documentElement.dataset.returnRouter).toBe("connected");
    view.unmount();
    emit("disconnected");
    await act(async () => {
      refuse(new Response(null, { status: 502 }));
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(document.documentElement.dataset.returnRouter).toBe("connected");
    expect(fetchCalls.filter((call) => call.url.endsWith("/webrtc/return-audio-ticket"))).toHaveLength(1);

    cleanup();
    fetchCalls = [];
    let connected: () => void = () => undefined;
    const original = lk.FakeRoom.prototype.connect;
    lk.FakeRoom.prototype.connect = async function (this: InstanceType<typeof lk.FakeRoom>) {
      await new Promise<void>((resolve) => (connected = resolve));
      this.state = "connected";
    };
    try {
      const late = await openRouter();
      late.unmount();
      await act(async () => {
        connected();
        await vi.advanceTimersByTimeAsync(0);
      });
    } finally {
      lk.FakeRoom.prototype.connect = original;
    }
    expect(fetchCalls.some((call) => call.url.endsWith("/webrtc/return-audio-ticket"))).toBe(false);
  });
});

// Chromium leaves a remote WebRTC track silent in Web Audio unless a media element plays it too.
it("keeps every subscribed track playing, muted, in an element, and lets it go when the track leaves or the page closes", async () => {
  routes = [guestRoute("guest-anna")];
  const view = await openRouter();
  await settle();
  emit("trackSubscribed", ...audioTrack("anna-mic", "t1", "mic", "guest-anna"));
  const keep = FakeAudio.all.find((audio) => audio.srcObject !== undefined)!;
  expect(keep.muted).toBe(true);
  expect(keep.paused).toBe(false);
  expect((keep.srcObject as { label: string }).label).toBe("anna-mic");
  // The same track again replaces the element.
  emit("trackSubscribed", ...audioTrack("anna-mic", "t1", "mic", "guest-anna"));
  expect(keep.paused).toBe(true);
  const again = FakeAudio.all.filter((audio) => audio.srcObject !== undefined).at(-1)!;
  emit("trackUnsubscribed", null, { trackSid: "t1" });
  expect(again.paused).toBe(true);
  expect(again.srcObject).toBeNull();
  emit("trackSubscribed", ...audioTrack("cy-mic", "t2", "mic", "guest-cy"));
  const last = FakeAudio.all.filter((audio) => audio.srcObject !== undefined).at(-1)!;
  FakeAudio.play = () => Promise.reject(new Error("refused"));
  try {
    emit("trackSubscribed", ...audioTrack("dee-mic", "t3", "mic", "guest-dee"));
    await settle();
  } finally {
    FakeAudio.play = () => Promise.resolve();
  }
  view.unmount();
  expect(last.paused).toBe(true);
  expect(last.srcObject).toBeNull();
});

it("does not join the room when the page closed while it was being authorized", async () => {
  let authorize: (response: Response) => void = () => undefined;
  const fetchMock = vi.mocked(fetch);
  const original = fetchMock.getMockImplementation()!;
  fetchMock.mockImplementation(async (input, init) => {
    if (String(input).endsWith("/webrtc/renderer-token")) {
      fetchCalls.push({ url: String(input), init: init as RequestInit });
      return new Promise<Response>((resolve) => (authorize = resolve));
    }
    return original(input, init);
  });
  const view = await openRouter();
  view.unmount();
  await act(async () => {
    authorize(Response.json({ serverUrl: "wss://livekit.example", token: "fictional-token" }));
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(room().connectedWith).toBeNull();
});

// Bounded diagnostics for the runner's log: codes and numbers, never a key, a URL or a token.
describe("the router's diagnostics", () => {
  const lines = (spy: ReturnType<typeof vi.spyOn>): string[] => spy.mock.calls.map((call: unknown[]) => String(call[0]));

  it("reports the context, the program audio and the levels every ten seconds, and keeps the context running", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    try {
      contextState = "suspended";
      audioTicket = () => Response.json({ streamPath: "/radio/main/monitor-audio?ticket=fictional-ticket" });
      routes = [guestRoute("guest-anna", { returnAudioBus: "master" })];
      await openRouter();
      await settle();
      expect(resumes).toBeGreaterThan(0);
      room().remoteParticipants.set("guest-anna", { identity: "guest-anna" });
      emit("participantConnected");
      await settle();
      FakeAudio.all.find((audio) => audio.srcObject === undefined)!.fire("playing");
      meterLevel = 0.25;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      const said = lines(info);
      expect(said).toContain("[return-router] context suspended");
      expect(said).toContain("[return-router] program-audio requested");
      expect(said).toContain("[return-router] program-audio playing");
      expect(said).toContain("[return-router] levels program=0.25 mixes=1 mixpeak=0.25");
      expect(said.every((line) => line.startsWith("[return-router] ") && !/key|ticket|http/.test(line))).toBe(true);
    } finally {
      info.mockRestore();
    }
  });

  it("names why the program audio failed: the grant, a media error, the end of the stream or a refused play", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    try {
      audioTicket = () => new Response(null, { status: 401 });
      await openRouter();
      await settle();
      expect(lines(info)).toContain("[return-router] program-audio failed code=ticket_401");
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      expect(lines(info)).toContain("[return-router] levels program=none mixes=0 mixpeak=0");
      cleanup();
      info.mockClear();

      audioTicket = () => Response.json({ streamPath: "/radio/main/monitor-audio?ticket=t" });
      await openRouter();
      await settle();
      const player = FakeAudio.all.filter((audio) => audio.srcObject === undefined).at(-1)!;
      player.error = { code: 4 };
      player.fire("error");
      expect(lines(info)).toContain("[return-router] program-audio failed code=media_4");
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });
      const next = FakeAudio.all.filter((audio) => audio.srcObject === undefined).at(-1)!;
      next.fire("error");
      expect(lines(info)).toContain("[return-router] program-audio failed code=media_0");
      cleanup();
      info.mockClear();

      FakeAudio.play = () => Promise.reject(new Error("NotAllowedError"));
      try {
        await openRouter();
        await settle();
      } finally {
        FakeAudio.play = () => Promise.resolve();
      }
      expect(lines(info)).toContain("[return-router] program-audio failed code=play_refused");
      cleanup();
      info.mockClear();

      audioTicket = () => {
        throw new Error("network down");
      };
      await openRouter();
      await settle();
      expect(lines(info)).toContain("[return-router] program-audio failed code=unavailable");
    } finally {
      info.mockRestore();
    }
  });
});
