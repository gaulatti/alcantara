// The on-air contribution worker, with LiveKit, ffmpeg and the backend replaced by recorders.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import {
  BACKOFF_MS,
  FRAME_STALE_MS,
  MAX_QUEUE_SAMPLES,
  Mixer,
  OFF_AIR_HOLD_MS,
  STALE_LIST_MS,
  STREAM_STALE_MS,
  createWorker,
  ffmpegArgs,
  isOnAirTrack,
  readConfig,
} from "./worker.mjs";

const KEY = "fictional-renderer-key";
const env = {
  ALCANTARA_API_URL: "https://api.example.test/",
  WEBRTC_RENDERER_KEY: KEY,
  PROGRAM_ID: "modoitaliano.fm",
  CONTRIBUTION_RTMP_URL: "rtmp://palazzo:1935/live/contribution",
};

function harness({ guests = [], listStatus = 200, tokenStatus = 200, connectFails = false } = {}) {
  let clock = 1_000_000;
  const calls = [];
  const children = [];
  let handlers = null;
  const state = { guests, listStatus, tokenStatus, connectFails, list: null, streams: [], streamStatus: 200 };
  const fetch = async (url, init = {}) => {
    calls.push({ url, init });
    if (url.includes("/webrtc/on-air/stream")) {
      if (state.streamStatus !== 200) return new Response(null, { status: state.streamStatus });
      const stream = eventStream(init.signal);
      state.streams.push(stream);
      return stream.response;
    }
    if (url.includes("/webrtc/on-air")) {
      if (state.listStatus !== 200) return new Response(null, { status: state.listStatus });
      return Response.json(state.list ?? { programId: "modoitaliano.fm", guests: state.guests });
    }
    if (url.endsWith("/webrtc/renderer-token")) {
      if (state.tokenStatus !== 200) return new Response(null, { status: state.tokenStatus });
      return Response.json({ serverUrl: "wss://livekit.example.test", token: "fictional-token" });
    }
    throw new Error(`unexpected ${url}`);
  };
  const connectRoom = async (serverUrl, token, given) => {
    if (state.connectFails) throw new Error("refused");
    handlers = given;
    return { serverUrl, token };
  };
  const spawn = (command, args) => {
    const child = new EventEmitter();
    child.command = command;
    child.args = args;
    child.written = [];
    child.ended = false;
    child.stdin = new EventEmitter();
    child.stdin.write = (buffer) => child.written.push(new Int16Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 2));
    child.stdin.end = () => {
      child.ended = true;
      child.emit("exit", 0);
    };
    children.push(child);
    return child;
  };
  const logs = [];
  const worker = createWorker({ config: readConfig(env), fetch, connectRoom, spawn, now: () => clock, log: (m) => logs.push(m) });
  return {
    worker,
    calls,
    children,
    logs,
    state,
    handlers: () => handlers,
    advance: (ms) => (clock += ms),
  };
}

/** A held-open event stream the test writes to, as the backend's on-air stream does; aborting it errors the body. */
function eventStream(signal) {
  let controller;
  const body = new ReadableStream({ start: (value) => (controller = value) });
  const encoder = new TextEncoder();
  signal?.addEventListener("abort", () => {
    try {
      controller.error(new Error("aborted"));
    } catch {}
  });
  return {
    response: new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }),
    send: (guests) => controller.enqueue(encoder.encode(`id: 1\ndata: ${JSON.stringify({ programId: "modoitaliano.fm", guests })}\n\n`)),
    raw: (text) => controller.enqueue(encoder.encode(text)),
    end: () => controller.close(),
  };
}
/** Lets a held stream's reader take what was written. */
const drain = () => new Promise((resolve) => setImmediate(resolve));
const polls = (h) => h.calls.filter((call) => /\/webrtc\/on-air\?/.test(call.url)).length;

const track = (key, identity, name = "microphone") => ({ key, identity, name, kind: "audio" });
/** A track that is sending audio: subscribed, with a frame just received. */
const sending = (h, key, identity, name) => {
  h.handlers().track(track(key, identity, name));
  h.handlers().frame(key, Int16Array.from([1]));
};

test("reads its configuration and refuses what it cannot use", () => {
  assert.deepEqual(readConfig(env), {
    api: "https://api.example.test",
    key: KEY,
    programId: "modoitaliano.fm",
    target: "rtmp://palazzo:1935/live/contribution",
    pollMs: 1000,
    port: 8091,
  });
  assert.equal(readConfig({ ...env, CONTRIBUTION_POLL_MS: "250", CONTRIBUTION_HEALTH_PORT: "9000" }).pollMs, 250);
  assert.throws(() => readConfig({ ...env, WEBRTC_RENDERER_KEY: " " }), /WEBRTC_RENDERER_KEY is required/);
  assert.throws(() => readConfig({ ...env, PROGRAM_ID: "news/main" }), /not a program id/);
  assert.throws(() => readConfig({ ...env, CONTRIBUTION_RTMP_URL: "https://palazzo/" }), /must be rtmp/);
});

test("puts on air only on-air guests and the host's onair:host track, never talkback", () => {
  const live = new Set(["guest-anna"]);
  assert.equal(isOnAirTrack(track("a", "guest-anna"), live), true);
  assert.equal(isOnAirTrack(track("b", "guest-cy"), live), false);
  const program = "modoitaliano.fm";
  assert.equal(isOnAirTrack(track("c", "operator-host-mic-modoitaliano.fm", "onair:host"), live, program), true);
  // gaulatti/alcantara#879: the program's one host-mic identity. An older console's onair:host (another operator
  // connection) is taken only while that host mic is absent (transitional, gaulatti/alcantara#880).
  assert.equal(isOnAirTrack(track("c2", "operator-1", "onair:host"), live, program), true);
  assert.equal(isOnAirTrack(track("c2", "operator-1", "onair:host"), live, program, true), false);
  assert.equal(isOnAirTrack(track("c", "operator-host-mic-modoitaliano.fm", "onair:host"), live, program, true), true);
  assert.equal(isOnAirTrack(track("c3", "operator-host-mic-other.fm", "onair:host"), live, program), false);
  assert.equal(isOnAirTrack(track("c4", "operator-host-mic-modoitaliano.fm", "microphone"), live, program), false);
  assert.equal(isOnAirTrack(track("d", "operator-1", "talkback:all"), live, program), false);
  assert.equal(isOnAirTrack(track("e", "guest-anna", "talkback:x"), live, program), false);
  assert.equal(isOnAirTrack(track("f", "operator-1", "microphone"), live, program), false);
  assert.equal(isOnAirTrack(track("g", "desktop-program-feed-x", "onair:host"), live, program), false);
  assert.equal(isOnAirTrack({ ...track("h", "guest-anna"), kind: "other" }, live), false);
});

test("mixes the sources sample by sample, clips, pads silence and keeps every source close to live", () => {
  const mixer = new Mixer();
  mixer.push("a", Int16Array.from([1000, 2000, 30000]));
  mixer.push("b", Int16Array.from([1, 2, 30000, 7]));
  assert.deepEqual([...mixer.pull(2)], [1001, 2002]);
  assert.deepEqual([...mixer.pull(3)], [32767, 7, 0]);
  mixer.push("c", Int16Array.from([-30000]));
  mixer.push("d", Int16Array.from([-30000]));
  assert.deepEqual([...mixer.pull(1)], [-32768]);
  for (let i = 0; i < 20; i += 1) mixer.push("fast", new Int16Array(MAX_QUEUE_SAMPLES / 8).fill(i));
  const queued = mixer.queues.get("fast").reduce((n, chunk) => n + chunk.length, 0);
  assert.ok(queued <= MAX_QUEUE_SAMPLES);
  assert.equal(mixer.pull(1)[0], 12);
  mixer.remove("fast");
  assert.equal(mixer.queues.has("fast"), false);
});

test("encodes AAC to Palazzo's RTMP input", () => {
  assert.deepEqual(ffmpegArgs("rtmp://palazzo:1935/live/contribution").slice(-4), ["48000", "-f", "flv", "rtmp://palazzo:1935/live/contribution"]);
  assert.deepEqual(ffmpegArgs("rtmp://x/y").slice(3, 12), ["-f", "s16le", "-ar", "48000", "-ac", "1", "-i", "pipe:0", "-c:a"]);
  assert.ok(ffmpegArgs("rtmp://x/y").includes("aac"));
  assert.equal(ffmpegArgs("rtmp://x/y").at(-1), "rtmp://x/y");
});

test("joins the room as the contribution listener with the renderer key, and asks for the program's on-air guests", async () => {
  const h = harness();
  await h.worker.step();
  const list = h.calls.find((call) => call.url.includes("/webrtc/on-air"));
  assert.equal(list.url, "https://api.example.test/webrtc/on-air?programId=modoitaliano.fm");
  assert.equal(list.init.headers["X-Renderer-Key"], KEY);
  const token = h.calls.find((call) => call.url.endsWith("/webrtc/renderer-token"));
  assert.deepEqual(JSON.parse(token.init.body), { programId: "modoitaliano.fm", role: "contribution" });
  assert.equal(token.init.headers["X-Renderer-Key"], KEY);
  assert.equal(h.worker.metrics.state.roomConnected, 1);
  assert.equal(h.children.length, 0, "nobody on air, no RTMP connection");
  await h.worker.step();
  assert.equal(h.calls.filter((call) => call.url.endsWith("/webrtc/renderer-token")).length, 1);
});

test("opens the push only while someone is on air, mixes what they say in real time, and closes it after a short hold", async () => {
  const h = harness({ guests: ["guest-anna"] });
  await h.worker.step();
  sending(h, "anna", "guest-anna");
  sending(h, "cy", "guest-cy");
  sending(h, "talk", "operator-1", "talkback:all");
  await h.worker.step();
  assert.equal(h.children.length, 1);
  assert.equal(h.children[0].command, "ffmpeg");
  assert.equal(h.children[0].args.at(-1), "rtmp://palazzo:1935/live/contribution");
  assert.equal(h.worker.metrics.state.sources, 1);
  h.handlers().frame("anna", new Int16Array(960).fill(100));
  h.handlers().frame("cy", new Int16Array(960).fill(5000));
  h.handlers().frame("talk", new Int16Array(960).fill(7000));
  h.handlers().frame("unknown", new Int16Array(960).fill(9));
  h.advance(20);
  h.worker.writeAudio();
  const written = h.children[0].written.at(-1);
  assert.equal(written.length, 960);
  assert.ok(written.every((sample) => sample === 100), "only the on-air guest reaches air");
  h.worker.writeAudio();
  assert.equal(h.children[0].written.length, 1, "nothing more is due yet");

  // The host goes on air too, then everybody leaves.
  sending(h, "host", "operator-host-mic-modoitaliano.fm", "onair:host");
  h.handlers().frame("anna", Int16Array.from([1]));
  await h.worker.step();
  assert.equal(h.worker.metrics.state.sources, 2);
  h.state.guests = [];
  h.handlers().untrack("host");
  await h.worker.step();
  assert.equal(h.worker.isPushing(), true, "held through a quick change");
  h.advance(OFF_AIR_HOLD_MS);
  await h.worker.step();
  assert.equal(h.worker.isPushing(), false);
  assert.equal(h.children[0].ended, true);
  assert.equal(h.worker.metrics.counts.pushes.stopped, 1);
  // Frames that arrive off air are dropped.
  h.handlers().frame("anna", new Int16Array(10).fill(1));
  assert.equal(h.worker.mixer.queues.has("anna"), false);
  h.worker.writeAudio();
});

test("reopens a push that dropped, waiting longer after each failure", async () => {
  const h = harness({ guests: ["guest-anna"] });
  await h.worker.step();
  sending(h, "anna", "guest-anna");
  await h.worker.step();
  h.children[0].emit("exit", 1);
  assert.equal(h.worker.isPushing(), false);
  assert.equal(h.worker.metrics.counts.pushes.failed, 1);
  assert.deepEqual(h.logs, ["rtmp push ended unexpectedly"]);
  await h.worker.step();
  assert.equal(h.children.length, 1, "waits before trying again");
  h.advance(BACKOFF_MS[0]);
  h.handlers().frame("anna", Int16Array.from([1]));
  await h.worker.step();
  assert.equal(h.children.length, 2);
  h.children[1].emit("exit", 1);
  h.advance(BACKOFF_MS[0]);
  h.handlers().frame("anna", Int16Array.from([1]));
  await h.worker.step();
  assert.equal(h.children.length, 2);
  h.advance(BACKOFF_MS[1]);
  h.handlers().frame("anna", Int16Array.from([1]));
  await h.worker.step();
  assert.equal(h.children.length, 3);
  // A stale child's exit changes nothing; a stdin error is ignored.
  h.children[0].emit("exit", 1);
  h.children[2].stdin.emit("error", new Error("EPIPE"));
  assert.equal(h.worker.isPushing(), true);
  h.worker.stop();
  h.worker.stop();
});

test("keeps the last on-air list through a short backend outage, then takes everybody off air", async () => {
  const h = harness({ guests: ["guest-anna"] });
  await h.worker.step();
  sending(h, "anna", "guest-anna");
  await h.worker.step();
  h.state.listStatus = 503;
  h.advance(STALE_LIST_MS);
  h.handlers().frame("anna", Int16Array.from([1]));
  await h.worker.step();
  assert.equal(h.worker.isPushing(), true);
  assert.equal(h.worker.metrics.counts.polls.failure, 1);
  h.advance(1);
  h.handlers().frame("anna", Int16Array.from([1]));
  await h.worker.step();
  h.advance(OFF_AIR_HOLD_MS);
  await h.worker.step();
  assert.equal(h.worker.isPushing(), false);
  // A malformed answer is a failure too.
  h.state.listStatus = 200;
  h.state.list = { guests: [7] };
  await h.worker.step();
  assert.equal(h.worker.metrics.counts.polls.failure, 4);
});

test("starts off air when the backend has never answered", async () => {
  const h = harness({ guests: ["guest-anna"], listStatus: 500 });
  await h.worker.step();
  sending(h, "anna", "guest-anna");
  await h.worker.step();
  assert.equal(h.children.length, 0);
});

test("retries the room with backoff when the token or the connection fails, and rejoins after a disconnect", async () => {
  const h = harness({ tokenStatus: 401 });
  await h.worker.step();
  assert.equal(h.worker.metrics.counts.room.failed, 1);
  assert.deepEqual(h.logs, ["room connection failed"]);
  h.state.tokenStatus = 200;
  h.state.connectFails = true;
  await h.worker.step();
  assert.equal(h.worker.metrics.counts.room.failed, 1, "waits before trying again");
  h.advance(BACKOFF_MS[0]);
  await h.worker.step();
  assert.equal(h.worker.metrics.counts.room.failed, 2);
  h.state.connectFails = false;
  h.advance(BACKOFF_MS[1]);
  await h.worker.step();
  assert.equal(h.worker.metrics.state.roomConnected, 1);
  h.handlers().track(track("anna", "guest-anna"));
  h.handlers().disconnected();
  assert.equal(h.worker.metrics.state.roomConnected, 0);
  assert.equal(h.worker.room(), null);
  await h.worker.step();
  assert.equal(h.worker.metrics.counts.room.connected, 2);
});

test("renders bounded Prometheus metrics", async () => {
  const h = harness({ guests: ["guest-anna"] });
  await h.worker.step();
  const text = h.worker.metrics.render();
  assert.match(text, /^alcantara_contribution_polls_total\{result="ok"\} 1$/m);
  assert.match(text, /^alcantara_contribution_room_connected 1$/m);
  assert.match(text, /^alcantara_contribution_pushing 0$/m);
  assert.doesNotMatch(text, /modoitaliano|guest-|fictional/);
});

test("takes a source off air once it sends only digital silence, so a publisher that died does not hold the filler off", async () => {
  const h = harness({ guests: ["guest-anna"] });
  await h.worker.step();
  h.handlers().track(track("anna", "guest-anna"));
  await h.worker.step();
  assert.equal(h.children.length, 0, "subscribed but silent: not on air yet");
  h.handlers().frame("anna", Int16Array.from([1]));
  await h.worker.step();
  assert.equal(h.worker.isPushing(), true);
  h.advance(FRAME_STALE_MS - 1);
  // Exact zeros, as a dead or muted publisher's subscription delivers, are not signs of life.
  h.handlers().frame("anna", new Int16Array(480));
  await h.worker.step();
  assert.equal(h.worker.metrics.state.sources, 1);
  h.advance(1);
  await h.worker.step();
  assert.equal(h.worker.metrics.state.sources, 0);
  h.advance(OFF_AIR_HOLD_MS);
  await h.worker.step();
  assert.equal(h.worker.isPushing(), false);
  // A frame for a track it never saw counts for nothing.
  h.handlers().frame("ghost", Int16Array.from([5]));
  await h.worker.step();
  assert.equal(h.worker.isPushing(), false);
});

test("puts a cued guest on air the moment the stream says so, and takes them off as fast, without a poll", async () => {
  const h = harness();
  await h.worker.step();
  sending(h, "anna", "guest-anna");
  await h.worker.step();
  assert.equal(h.worker.isPushing(), false);
  const following = h.worker.follow();
  await drain();
  const [stream] = h.state.streams;
  assert.equal(h.calls.at(-1).url, "https://api.example.test/webrtc/on-air/stream?programId=modoitaliano.fm");
  assert.equal(h.calls.at(-1).init.headers["X-Renderer-Key"], KEY);
  // Split across reads, as a socket may deliver it.
  stream.raw(`id: 1\ndata: ${JSON.stringify({ programId: "modoitaliano.fm", guests: ["guest-anna"] }).slice(0, 10)}`);
  await drain();
  assert.equal(h.worker.isPushing(), false);
  stream.raw(`${JSON.stringify({ programId: "modoitaliano.fm", guests: ["guest-anna"] }).slice(10)}\n\n`);
  await drain();
  assert.equal(h.worker.isPushing(), true, "on air without waiting for the next poll");
  h.handlers().frame("anna", Int16Array.from([7]));
  assert.equal(h.worker.mixer.queues.has("anna"), true);

  // Wrap: the guest's audio stops reaching the mix at once; the push closes after the same short hold as before.
  stream.send([]);
  await drain();
  h.worker.mixer.remove("anna");
  h.handlers().frame("anna", Int16Array.from([7]));
  assert.equal(h.worker.mixer.queues.has("anna"), false);
  h.advance(OFF_AIR_HOLD_MS);
  await h.worker.step();
  assert.equal(h.worker.isPushing(), false);

  // While the stream is live the poll rests.
  const before = polls(h);
  await h.worker.step();
  assert.equal(polls(h), before);
  assert.match(h.worker.metrics.render(), /^alcantara_contribution_streaming 1$/m);
  assert.match(h.worker.metrics.render(), /^alcantara_contribution_polls_total\{result="skipped"\} 2$/m);
  stream.end();
  await following;
  assert.equal(h.worker.streamRetryMs(), 0, "a stream that worked is opened again at once");
});

test("falls back to the poll when the stream ends or goes quiet, and opens it again", async () => {
  const h = harness({ guests: ["guest-anna"] });
  const first = h.worker.follow();
  await drain();
  h.state.streams[0].send([]);
  await drain();
  await h.worker.step();
  assert.equal(polls(h), 0);
  // Quiet past the bound: the step drops it and polls.
  h.advance(STREAM_STALE_MS);
  await h.worker.step();
  await first;
  assert.equal(polls(h), 1);
  assert.match(h.worker.metrics.render(), /^alcantara_contribution_streaming 0$/m);
  assert.match(h.worker.metrics.render(), /^alcantara_contribution_stream_total\{result="ended"\} 1$/m);

  // Reconnected: the stream leads again; when it ends, the next step polls.
  const second = h.worker.follow();
  await drain();
  h.state.streams[1].send(["guest-anna"]);
  await drain();
  await h.worker.step();
  assert.equal(polls(h), 1);
  h.state.streams[1].end();
  await second;
  await h.worker.step();
  assert.equal(polls(h), 2);
  assert.match(h.worker.metrics.render(), /^alcantara_contribution_stream_total\{result="connected"\} 2$/m);
});

test("backs off a stream that brings no list: an older backend, a refusal, a malformed event or a dead socket", async () => {
  const h = harness();
  h.state.streamStatus = 404;
  await h.worker.follow();
  assert.equal(h.worker.streamRetryMs(), BACKOFF_MS[0]);
  h.state.streamStatus = 401;
  await h.worker.follow();
  assert.equal(h.worker.streamRetryMs(), BACKOFF_MS[1]);
  h.state.streamStatus = 200;
  const malformed = h.worker.follow();
  await drain();
  h.state.streams[0].raw('data: {"guests":"guest-anna"}\n\n');
  await malformed;
  assert.equal(h.worker.streamRetryMs(), BACKOFF_MS[2]);
  const empty = h.worker.follow();
  await drain();
  h.state.streams[1].raw(": keep-alive\n\n");
  h.state.streams[1].end();
  await empty;
  assert.equal(h.worker.streamRetryMs(), BACKOFF_MS[2]);
  assert.match(h.worker.metrics.render(), /^alcantara_contribution_stream_total\{result="failed"\} 4$/m);
  // Polling carried on throughout.
  await h.worker.step();
  assert.equal(polls(h), 1);
  // Stopping the worker drops an open stream.
  const open = h.worker.follow();
  await drain();
  h.worker.stop();
  await open;
});

test("still takes a dead publisher off air on the silence timer while the stream says they are cued", async () => {
  const h = harness();
  await h.worker.step();
  const following = h.worker.follow();
  await drain();
  h.state.streams[0].send(["guest-anna"]);
  await drain();
  sending(h, "anna", "guest-anna");
  await h.worker.step();
  assert.equal(h.worker.isPushing(), true);
  h.advance(FRAME_STALE_MS);
  h.state.streams[0].send(["guest-anna"]);
  await drain();
  assert.equal(h.worker.metrics.state.sources, 0);
  h.advance(OFF_AIR_HOLD_MS);
  h.state.streams[0].send(["guest-anna"]);
  await drain();
  assert.equal(h.worker.isPushing(), false);
  h.worker.stop();
  await following;
});

test("keeps an older console's host mic on air alone, and only the program's host mic once both are in the room", async () => {
  const h = harness();
  await h.worker.step();
  // A console from before the host-mic token, on its ordinary operator connection: still on air (#880 removes this).
  sending(h, "old", "operator-1", "onair:host");
  await h.worker.step();
  assert.equal(h.worker.isPushing(), true);
  assert.equal(h.worker.metrics.state.sources, 1);

  // The program's host mic joins: only it reaches air, never both (gaulatti/alcantara#879).
  sending(h, "new", "operator-host-mic-modoitaliano.fm", "onair:host");
  await h.worker.step();
  assert.equal(h.worker.metrics.state.sources, 1);
  // What was queued before the host mic joined plays out first (at most MAX_QUEUE_SAMPLES).
  h.advance(1_000);
  h.worker.writeAudio();
  h.handlers().frame("old", new Int16Array(960).fill(3000));
  h.handlers().frame("new", new Int16Array(960).fill(200));
  h.advance(20);
  h.worker.writeAudio();
  const written = h.children[0].written.at(-1);
  assert.ok(written.length > 0);
  assert.ok(written.every((sample) => sample === 200), "only the program's host mic is mixed");

  // It leaves: the older console's mic is back on its own.
  h.handlers().untrack("new");
  await h.worker.step();
  assert.equal(h.worker.metrics.state.sources, 1);
});
