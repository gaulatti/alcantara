import { act, cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
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
  createDelay() {
    return node("delay", { delayTime: { value: -1 } });
  }
  async resume() {}
  async close() {
    audioClosed = true;
  }
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

beforeEach(() => {
  vi.useFakeTimers();
  nodes = [];
  audioClosed = false;
  lk.FakeRoom.last = null;
  routes = [];
  tokenStatus = 200;
  stateStatus = 200;
  fetchCalls = [];
  window.sessionStorage.clear();
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
  expect(room().unpublished).toContain(first);
  expect(first.stopped).toBe(true);
  expect(sourceOf("anna-mic").disconnected).toBeGreaterThan(0);

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
