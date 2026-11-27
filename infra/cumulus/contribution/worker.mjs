// The on-air contribution worker (gaulatti/alcantara calls): the station's one producer for Palazzo's live input. It
// listens to the program's call room, hidden, and mixes the guests the operator cued live plus the host's
// `onair:host` track into one feed it pushes to Palazzo over RTMP. It connects to Palazzo only while someone is on
// air: Palazzo counts a connected input as live even when it is silent, and a live input holds the filler off.
// Talkback (`talkback:*`) never reaches air. The renderer key comes from the environment and is never logged.
import { spawn as spawnProcess } from "node:child_process";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

const PROGRAM_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
export const SAMPLE_RATE = 48_000;
/** A source's queue is cut back to this much audio, so a source that runs fast never builds up delay on air. */
export const MAX_QUEUE_SAMPLES = SAMPLE_RATE / 4;
/** Nobody on air for this long before the RTMP connection closes, so a quick cue change does not drop it. */
export const OFF_AIR_HOLD_MS = 1_500;
/**
 * A source that sent nothing but digital silence (or nothing at all) for this long is off air. A publisher that dies
 * without leaving stays in the room until LiveKit notices (about 20 s), and its subscription keeps delivering exact
 * zeros; that silence must not keep Palazzo's live input, and so the filler hold, on. A live microphone always carries
 * a noise floor, so a speaker's pauses never look like this; a muted one does, and leaves the air the same way.
 */
export const FRAME_STALE_MS = 10_000;
/** The last on-air list keeps applying while the backend does not answer, for at most this long; then off air. */
export const STALE_LIST_MS = 30_000;
/**
 * The on-air stream counts as live while its last list is this recent; the backend sends one at least every 5 s.
 * Past it the stream is dropped and opened again, and the poll takes over meanwhile.
 */
export const STREAM_STALE_MS = 12_000;
/** Waits before the RTMP push and the room connection are tried again after their first, second and later failures. */
export const BACKOFF_MS = [1_000, 3_000, 10_000];

export function readConfig(env) {
  const need = (name) => {
    const value = (env[name] ?? "").trim();
    if (!value) throw new Error(`${name} is required`);
    return value;
  };
  const programId = need("PROGRAM_ID");
  if (!PROGRAM_ID.test(programId)) throw new Error("PROGRAM_ID is not a program id");
  const target = need("CONTRIBUTION_RTMP_URL");
  if (!/^rtmp:\/\/[^/\s]+\/\S+$/.test(target)) throw new Error("CONTRIBUTION_RTMP_URL must be rtmp://host:port/path");
  return {
    api: need("ALCANTARA_API_URL").replace(/\/$/, ""),
    key: need("WEBRTC_RENDERER_KEY"),
    programId,
    target,
    pollMs: Number(env.CONTRIBUTION_POLL_MS ?? 1_000),
    port: Number(env.CONTRIBUTION_HEALTH_PORT ?? 8091),
  };
}

/** Whether a track goes on air: an on-air guest's audio, or an operator's `onair:host` track. Never talkback. */
export function isOnAirTrack(track, onAirGuests) {
  if (track.kind !== "audio") return false;
  if (track.name.startsWith("talkback:")) return false;
  if (track.identity.startsWith("guest-")) return onAirGuests.has(track.identity);
  return track.identity.startsWith("operator-") && track.name === "onair:host";
}

/** Sums the on-air sources into one mono 48 kHz feed. Each source queues what it receives; a pull drains them all. */
export class Mixer {
  constructor() {
    this.queues = new Map();
  }
  push(key, samples) {
    const queue = this.queues.get(key) ?? [];
    queue.push(samples);
    let length = queue.reduce((total, chunk) => total + chunk.length, 0);
    while (length > MAX_QUEUE_SAMPLES && queue.length > 1) length -= queue.shift().length;
    this.queues.set(key, queue);
  }
  remove(key) {
    this.queues.delete(key);
  }
  pull(count) {
    const mixed = new Int32Array(count);
    for (const queue of this.queues.values()) {
      let offset = 0;
      while (offset < count && queue.length) {
        const chunk = queue[0];
        const take = Math.min(count - offset, chunk.length);
        for (let i = 0; i < take; i += 1) mixed[offset + i] += chunk[i];
        offset += take;
        if (take === chunk.length) queue.shift();
        else queue[0] = chunk.subarray(take);
      }
    }
    const out = new Int16Array(count);
    for (let i = 0; i < count; i += 1) out[i] = Math.max(-32768, Math.min(32767, mixed[i]));
    return out;
  }
}

export function ffmpegArgs(target) {
  return [
    "-hide_banner", "-loglevel", "warning",
    "-f", "s16le", "-ar", String(SAMPLE_RATE), "-ac", "1", "-i", "pipe:0",
    "-c:a", "aac", "-b:a", "160k", "-ar", String(SAMPLE_RATE),
    "-f", "flv", target,
  ];
}

export function createMetrics() {
  const counts = {
    polls: { ok: 0, failure: 0, skipped: 0 },
    stream: { connected: 0, lists: 0, ended: 0, failed: 0 },
    pushes: { started: 0, stopped: 0, failed: 0 },
    room: { connected: 0, failed: 0 },
  };
  const state = { sources: 0, pushing: 0, roomConnected: 0, streaming: 0 };
  return {
    counts,
    state,
    render() {
      const lines = [
        "# HELP alcantara_contribution_polls_total On-air list polls by bounded result.",
        "# TYPE alcantara_contribution_polls_total counter",
        ...Object.entries(counts.polls).map(([result, n]) => `alcantara_contribution_polls_total{result="${result}"} ${n}`),
        "# HELP alcantara_contribution_stream_total On-air stream events: connected, lists received, ended, failed to open.",
        "# TYPE alcantara_contribution_stream_total counter",
        ...Object.entries(counts.stream).map(([result, n]) => `alcantara_contribution_stream_total{result="${result}"} ${n}`),
        "# HELP alcantara_contribution_pushes_total RTMP pushes to Palazzo by bounded result.",
        "# TYPE alcantara_contribution_pushes_total counter",
        ...Object.entries(counts.pushes).map(([result, n]) => `alcantara_contribution_pushes_total{result="${result}"} ${n}`),
        "# HELP alcantara_contribution_room_connections_total Call room connections by bounded result.",
        "# TYPE alcantara_contribution_room_connections_total counter",
        ...Object.entries(counts.room).map(([result, n]) => `alcantara_contribution_room_connections_total{result="${result}"} ${n}`),
        "# HELP alcantara_contribution_on_air_sources Sources mixed into the station's live input.",
        "# TYPE alcantara_contribution_on_air_sources gauge",
        `alcantara_contribution_on_air_sources ${state.sources}`,
        "# HELP alcantara_contribution_pushing Whether the RTMP push to Palazzo is open.",
        "# TYPE alcantara_contribution_pushing gauge",
        `alcantara_contribution_pushing ${state.pushing}`,
        "# HELP alcantara_contribution_room_connected Whether the worker is in the call room.",
        "# TYPE alcantara_contribution_room_connected gauge",
        `alcantara_contribution_room_connected ${state.roomConnected}`,
        "# HELP alcantara_contribution_streaming Whether the on-air stream is live (a recent list), so the poll rests.",
        "# TYPE alcantara_contribution_streaming gauge",
        `alcantara_contribution_streaming ${state.streaming}`,
      ];
      return `${lines.join("\n")}\n`;
    },
  };
}

/**
 * The worker, with every outside effect injected: `fetch` for the backend, `connectRoom` for LiveKit and `spawn`
 * for ffmpeg. `step()` runs one pass; `start()` runs passes on a timer and writes audio while pushing.
 */
export function createWorker({ config, fetch, connectRoom, spawn, now = Date.now, log = () => {} }) {
  const metrics = createMetrics();
  const mixer = new Mixer();
  const tracks = new Map();
  const lastFrameAt = new Map();
  let onAirGuests = new Set();
  let listAt = null;
  let room = null;
  let connecting = false;
  let roomFailures = 0;
  let roomRetryAt = 0;
  let push = null;
  let pushFailures = 0;
  let pushRetryAt = 0;
  let lastOnAirAt = null;
  let streamAt = null;
  let stream = null;
  let streamFailures = 0;

  const headers = { "X-Renderer-Key": config.key, "Content-Type": "application/json" };
  const backoff = (failures) => BACKOFF_MS[Math.min(failures - 1, BACKOFF_MS.length - 1)];

  const query = `programId=${encodeURIComponent(config.programId)}`;
  const guestsOf = (body) => {
    if (!Array.isArray(body?.guests) || !body.guests.every((guest) => typeof guest === "string")) throw new Error("malformed on-air list");
    return new Set(body.guests);
  };
  const streamLive = () => stream !== null && streamAt !== null && now() - streamAt < STREAM_STALE_MS;

  async function poll() {
    // The stream is the faster source; the poll rests while it is live and takes over when it is not.
    if (streamLive()) {
      metrics.counts.polls.skipped += 1;
      return;
    }
    try {
      const response = await fetch(`${config.api}/webrtc/on-air?${query}`, { headers });
      if (!response.ok) throw new Error(`on-air list ${response.status}`);
      onAirGuests = guestsOf(await response.json());
      listAt = now();
      metrics.counts.polls.ok += 1;
    } catch {
      metrics.counts.polls.failure += 1;
      // Fail closed: past the stale window nobody is on air.
      if (listAt === null || now() - listAt > STALE_LIST_MS) onAirGuests = new Set();
    }
  }

  async function ensureRoom() {
    if (room || connecting || now() < roomRetryAt) return;
    connecting = true;
    try {
      const response = await fetch(`${config.api}/webrtc/renderer-token`, {
        method: "POST",
        headers,
        body: JSON.stringify({ programId: config.programId, role: "contribution" }),
      });
      if (!response.ok) throw new Error(`token ${response.status}`);
      const { serverUrl, token } = await response.json();
      room = await connectRoom(serverUrl, token, {
        track: (track) => tracks.set(track.key, track),
        untrack: (key) => {
          tracks.delete(key);
          lastFrameAt.delete(key);
          mixer.remove(key);
        },
        frame: (key, samples) => {
          const track = tracks.get(key);
          if (track && samples.some((sample) => sample !== 0)) lastFrameAt.set(key, now());
          if (push && track && isOnAirTrack(track, onAirGuests)) mixer.push(key, samples);
        },
        disconnected: () => {
          room = null;
          tracks.clear();
          lastFrameAt.clear();
          metrics.state.roomConnected = 0;
        },
      });
      roomFailures = 0;
      metrics.counts.room.connected += 1;
      metrics.state.roomConnected = 1;
    } catch {
      roomFailures += 1;
      roomRetryAt = now() + backoff(roomFailures);
      metrics.counts.room.failed += 1;
      log("room connection failed");
    } finally {
      connecting = false;
    }
  }

  function startPush() {
    const child = spawn("ffmpeg", ffmpegArgs(config.target));
    const session = { child, startedAt: now(), written: 0, closing: false };
    child.stdin.on("error", () => {});
    child.on("exit", () => {
      if (push !== session) return;
      push = null;
      metrics.state.pushing = 0;
      if (session.closing) return;
      pushFailures += 1;
      pushRetryAt = now() + backoff(pushFailures);
      metrics.counts.pushes.failed += 1;
      log("rtmp push ended unexpectedly");
    });
    push = session;
    metrics.counts.pushes.started += 1;
    metrics.state.pushing = 1;
  }

  function stopPush() {
    if (!push) return;
    const session = push;
    session.closing = true;
    push = null;
    metrics.state.pushing = 0;
    metrics.counts.pushes.stopped += 1;
    session.child.stdin.end();
    for (const key of tracks.keys()) mixer.remove(key);
  }

  /** Writes the mix due since the push started, in real time, so ffmpeg is fed at the rate air plays it. */
  function writeAudio() {
    if (!push) return;
    const due = Math.floor(((now() - push.startedAt) * SAMPLE_RATE) / 1000) - push.written;
    if (due <= 0) return;
    const samples = mixer.pull(due);
    push.written += due;
    push.child.stdin.write(Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength));
  }

  /**
   * Holds the on-air stream open until it ends, applying each list as it arrives: a cue goes on air, and a wrap off,
   * without waiting for the next poll. Never throws; `streamRetryMs()` says how long to wait before the next one.
   */
  async function follow() {
    const abort = new AbortController();
    const session = { abort, lists: 0 };
    stream = session;
    try {
      const response = await fetch(`${config.api}/webrtc/on-air/stream?${query}`, {
        headers: { "X-Renderer-Key": config.key, Accept: "text/event-stream" },
        signal: abort.signal,
      });
      if (!response.ok || !response.body) throw new Error(`on-air stream ${response.status}`);
      metrics.counts.stream.connected += 1;
      const decoder = new TextDecoder();
      let buffered = "";
      for await (const chunk of response.body) {
        buffered += decoder.decode(chunk, { stream: true });
        let end;
        while ((end = buffered.indexOf("\n\n")) !== -1) {
          const event = buffered.slice(0, end);
          buffered = buffered.slice(end + 2);
          const data = event
            .split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trimStart())
            .join("\n");
          if (!data) continue;
          onAirGuests = guestsOf(JSON.parse(data));
          listAt = streamAt = now();
          session.lists += 1;
          streamFailures = 0;
          metrics.counts.stream.lists += 1;
          metrics.state.streaming = 1;
          evaluate();
        }
      }
    } catch {
      // Refused, unreachable, malformed or dropped: the next one waits, as the room and the push do.
    } finally {
      // A stream that brought no list (an older backend, a refusal) counts as a failure and backs off.
      if (session.lists) metrics.counts.stream.ended += 1;
      else {
        metrics.counts.stream.failed += 1;
        streamFailures += 1;
      }
      if (stream === session) {
        stream = null;
        streamAt = null;
        metrics.state.streaming = 0;
      }
    }
  }

  function evaluate() {
    const time = now();
    const sources = [...tracks.values()].filter(
      (track) => isOnAirTrack(track, onAirGuests) && time - (lastFrameAt.get(track.key) ?? -Infinity) < FRAME_STALE_MS,
    );
    metrics.state.sources = sources.length;
    if (sources.length) {
      lastOnAirAt = time;
      if (!push && time >= pushRetryAt) startPush();
    } else if (push && (lastOnAirAt === null || time - lastOnAirAt >= OFF_AIR_HOLD_MS)) {
      stopPush();
      pushFailures = 0;
    }
  }

  async function step() {
    // A stream that went quiet is stuck: drop it, so it is opened again, and poll meanwhile.
    if (stream && streamAt !== null && now() - streamAt >= STREAM_STALE_MS) stream.abort.abort();
    await poll();
    await ensureRoom();
    evaluate();
  }

  return {
    step,
    follow,
    streamRetryMs: () => (streamFailures ? backoff(streamFailures) : 0),
    writeAudio,
    metrics,
    mixer,
    isPushing: () => push !== null,
    stop: () => {
      stream?.abort.abort();
      stopPush();
    },
    room: () => room,
  };
}

/** The LiveKit side, on @livekit/rtc-node: subscribes to every audio track and hands its mono 48 kHz frames over. */
export async function connectLiveKitRoom(serverUrl, token, handlers) {
  const { Room, RoomEvent, AudioStream, TrackKind } = await import("@livekit/rtc-node");
  const room = new Room();
  const describe = (track, publication, participant) => ({
    key: publication.sid,
    identity: participant.identity,
    name: publication.name ?? "",
    kind: track.kind === TrackKind.KIND_AUDIO ? "audio" : "other",
  });
  room.on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
    const described = describe(track, publication, participant);
    handlers.track(described);
    if (described.kind !== "audio") return;
    void (async () => {
      for await (const frame of new AudioStream(track, SAMPLE_RATE, 1)) handlers.frame(described.key, frame.data);
    })().catch(() => handlers.untrack(described.key));
  });
  room.on(RoomEvent.TrackUnsubscribed, (_track, publication) => handlers.untrack(publication.sid));
  room.on(RoomEvent.Disconnected, () => handlers.disconnected());
  await room.connect(serverUrl, token, { autoSubscribe: true, dynacast: false });
  return room;
}

async function main() {
  const config = readConfig(process.env);
  const worker = createWorker({
    config,
    fetch: globalThis.fetch,
    connectRoom: connectLiveKitRoom,
    spawn: (command, args) => spawnProcess(command, args, { stdio: ["pipe", "ignore", "inherit"] }),
    log: (message) => console.log(JSON.stringify({ event: "contribution", message })),
  });
  createServer((request, response) => {
    if (request.url === "/metrics") {
      response.writeHead(200, { "Content-Type": "text/plain; version=0.0.4" });
      response.end(worker.metrics.render());
      return;
    }
    response.writeHead(worker.room() ? 200 : 503).end();
  }).listen(config.port, "0.0.0.0");
  setInterval(() => worker.writeAudio(), 20);
  void (async () => {
    for (;;) {
      await worker.follow();
      await new Promise((resolve) => setTimeout(resolve, worker.streamRetryMs()));
    }
  })();
  for (;;) {
    await worker.step();
    await new Promise((resolve) => setTimeout(resolve, config.pollMs));
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(JSON.stringify({ event: "contribution", message: "stopped", reason: error instanceof Error ? error.message : "unknown" }));
    process.exit(1);
  });
}
