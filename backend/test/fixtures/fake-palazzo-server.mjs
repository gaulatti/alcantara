// Fake Palazzo: a local, in-memory stand-in for Palazzo's private,
// program-scoped HTTP API, for walking Alcantara's radio operator flow in its
// Docker Compose stack. Plain Node, no dependencies, no outbound network calls
// (filler assets are never downloaded). Not a production component: it runs
// only under the opt-in `fake-palazzo` Compose profile, and the deployment
// tests check that nothing that ships enables it.
//
// Contract source: Alcantara backend/src/radio/palazzo-machine.client.ts and
// palazzo-contract.ts (consumer). Shapes and lifecycle semantics follow
// Palazzo's stream.controller / broadcast-lifecycle / playback-telemetry
// services as read from a local checkout; see docs/fake-palazzo.md for what
// is faked.

import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';

const env = process.env;
const num = (name, fallback) => {
  const value = Number(env[name]);
  return env[name] !== undefined && env[name] !== '' && Number.isFinite(value)
    ? value
    : fallback;
};
const flag = (name, fallback) =>
  env[name] === undefined || env[name] === ''
    ? fallback
    : !['0', 'false', 'no', 'off'].includes(env[name].toLowerCase());

const CONFIG = {
  port: num('PORT', 3100),
  host: env.HOST || '0.0.0.0',
  trackSeconds: num('FAKE_TRACK_SECONDS', 240),
  levelsIntervalMs: num('FAKE_LEVELS_INTERVAL_MS', 1000),
  heartbeatMs: num('FAKE_HEARTBEAT_MS', 10_000),
  audibleRms: num('FAKE_AUDIBLE_RMS', 0.2),
  startDelayMs: num('FAKE_START_DELAY_MS', 300),
  introSeconds: num('FAKE_INTRO_SECONDS', 5),
  instantSeconds: num('FAKE_INSTANT_SECONDS', 3),
  redactUrls: flag('FAKE_REDACT_URLS', true),
  capabilities: (env.FAKE_CAPABILITIES ?? 'next.bumper')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean),
  fillerClearsSilence: flag('FAKE_FILLER_CLEARS_SILENCE', true),
  bindFillerOnPlayback: flag('FAKE_BIND_FILLER_ON_PLAYBACK', false),
  acceptUnpreparedFiller: flag('FAKE_ACCEPT_UNPREPARED_FILLER', false),
  logLimit: num('FAKE_LOG_LIMIT', 2000),
};

const MAX_REPLAY_EVENTS = 512;
const SONG_CHANGE_WINDOW_MS = 5_000;
const PROGRAM_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const IDENTIFIER = /^[A-Za-z0-9._-]{1,128}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const LOGGED_HEADERS = [
  'accept',
  'content-type',
  'idempotency-key',
  'x-command-sequence',
  'x-filler-version',
  'last-event-id',
];

class HttpError extends Error {
  constructor(status, body) {
    super(typeof body === 'string' ? body : JSON.stringify(body));
    this.status = status;
    this.body = typeof body === 'string' ? { error: body } : body;
  }
}

// ---------------------------------------------------------------------------
// Per-program state
// ---------------------------------------------------------------------------

const programs = new Map();
const requestLog = [];
let logCounter = 0;

function program(programId) {
  let p = programs.get(programId);
  if (p) return p;
  const now = new Date().toISOString();
  p = {
    programId,
    // One Palazzo instance per program: Alcantara rejects two programs that
    // resolve to the same instance identity.
    instanceId: `fake-palazzo-${programId}`,
    bootId: randomUUID(),
    bootedAt: now,
    sequence: 0,
    liquidsoapSequence: 0,
    replay: [],
    snapshotById: new Map(),
    subscribers: new Set(),
    // mute-events (gaulatti/alcantara#734): Liquidsoap is down; the sampling loop emits nothing.
    liquidsoapDown: false,
    staleSince: null,
    lastSampleAt: null,
    lastHeartbeatAt: 0,
    track: null,
    trackStartedMs: 0,
    trackLengthSeconds: null,
    trackTimer: null,
    pendingStart: null,
    intro: null,
    introTimer: null,
    next: null,
    lastEnded: null,
    instants: new Map(),
    mixer: {
      mainVolume: 1,
      songVolume: 1,
      instantVolume: 1,
      songMuted: false,
      instantMuted: false,
    },
    silent: false,
    songCommands: new Map(),
    nextCommands: new Map(),
    fillers: new Map(),
    activeFiller: null,
    boundBy: null,
    lifecycle: {
      requestedState: 'reconciliation-required',
      actualState: 'reconciliation-required',
      lastSequence: 0,
      lastCommand: null,
      commands: new Map(),
      timestamps: {},
    },
  };
  programs.set(programId, p);
  return p;
}

function round(value) {
  return Math.round(value * 10_000) / 10_000;
}

function jitter(value) {
  return value <= 0 ? 0 : round(value * (0.9 + Math.random() * 0.2));
}

function level(rms) {
  return { rms, peak: round(Math.min(1, rms * 1.6)) };
}

function levels(p) {
  if (p.silent) {
    return {
      song: level(0),
      instant: level(0),
      intro: level(0),
      output: level(0),
    };
  }
  const song = p.track ? jitter(CONFIG.audibleRms) : 0;
  const intro = p.intro ? jitter(CONFIG.audibleRms * 0.8) : 0;
  const instant = p.instants.size ? jitter(CONFIG.audibleRms * 0.75) : 0;
  // Palazzo's local playlist plays when the live song queue runs dry.
  const filler = !p.track && p.activeFiller ? jitter(CONFIG.audibleRms) : 0;
  const m = p.mixer;
  const output =
    m.mainVolume *
    ((m.songMuted ? 0 : song * m.songVolume) +
      intro +
      (m.instantMuted ? 0 : instant * m.instantVolume) +
      filler);
  return {
    song: level(song),
    instant: level(instant),
    intro: level(intro),
    output: level(round(Math.min(1, output))),
  };
}

function positionSeconds(p) {
  return p.track ? round((Date.now() - p.trackStartedMs) / 1000) : 0;
}

function playbackState(p) {
  const position = positionSeconds(p);
  return {
    schemaVersion: 1,
    instanceId: p.instanceId,
    bootId: p.bootId,
    sequence: p.sequence,
    availability: 'available',
    status: p.track ? 'playing' : 'idle',
    liquidsoap: {
      running: true,
      connected: !p.liquidsoapDown,
      staleSince: p.staleSince,
      lastSampleAt: p.lastSampleAt,
    },
    icecast: { connected: true },
    track: p.track ? { ...p.track } : null,
    intro: p.intro ? { ...p.intro } : null,
    positionSeconds: position,
    remainingSeconds:
      p.track && p.trackLengthSeconds !== null
        ? round(Math.max(0, p.trackLengthSeconds - position))
        : null,
    levels: levels(p),
    live: { onAir: false },
    capabilities: [...CONFIG.capabilities],
  };
}

function lifecycleState(p) {
  const l = p.lifecycle;
  return {
    schemaVersion: 1,
    programId: p.programId,
    instanceId: p.instanceId,
    requestedState: l.requestedState,
    actualState: l.actualState,
    readiness: l.actualState === 'ready',
    filler: {
      activeVersion: p.activeFiller,
      ready: p.activeFiller !== null,
      boundBy: p.boundBy,
    },
    transition: null,
    dependencies: { liquidsoap: true, control: true, icecast: true },
    playback: playbackState(p),
    lastSequence: l.lastSequence,
    lastCommand: l.lastCommand,
    timestamps: {
      bootedAt: p.bootedAt,
      ...l.timestamps,
      updatedAt: new Date().toISOString(),
    },
  };
}

// Palazzo strips URL- and credential-shaped keys from everything it sends on
// the event stream, snapshots included.
function sanitize(value) {
  if (!CONFIG.redactUrls) return value;
  if (Array.isArray(value)) return value.map(sanitize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !/(url|authorization|credential|password|token)/i.test(key))
      .map(([key, entry]) => [key, sanitize(entry)]),
  );
}

// ---------------------------------------------------------------------------
// Event stream
// ---------------------------------------------------------------------------

function writeFrame(res, event) {
  res.write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
}

function emit(p, type, data, occurredAt = new Date().toISOString()) {
  p.sequence += 1;
  const event = {
    schemaVersion: 1,
    id: `${p.bootId}:${p.sequence}`,
    instanceId: p.instanceId,
    bootId: p.bootId,
    sequence: p.sequence,
    type,
    occurredAt,
    data: sanitize(data),
  };
  p.replay.push(event);
  p.snapshotById.set(event.id, JSON.stringify(playbackState(p)));
  if (p.replay.length > MAX_REPLAY_EVENTS) {
    const dropped = p.replay.shift();
    if (dropped) p.snapshotById.delete(dropped.id);
  }
  for (const res of p.subscribers) writeFrame(res, event);
  return event;
}

function subscribe(p, req, res) {
  const lastEventId = header(req, 'last-event-id');
  const index = lastEventId
    ? p.replay.findIndex((event) => event.id === lastEventId)
    : -1;
  const replay = index >= 0 ? p.replay.slice(index + 1) : [];
  const stored = lastEventId ? p.snapshotById.get(lastEventId) : undefined;
  const snapshot = stored ? JSON.parse(stored) : playbackState(p);
  const snapshotId = `${snapshot.bootId}:${snapshot.sequence}`;
  const gap = !!lastEventId && lastEventId !== snapshotId && index < 0;
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();
  const envelope = {
    schemaVersion: 1,
    id: snapshotId,
    instanceId: snapshot.instanceId,
    bootId: snapshot.bootId,
    sequence: snapshot.sequence,
    occurredAt: new Date().toISOString(),
  };
  writeFrame(res, { ...envelope, type: 'snapshot', data: sanitize({ state: snapshot }) });
  if (gap) {
    writeFrame(res, {
      ...envelope,
      type: 'replay.gap',
      data: { reason: 'cursor_not_in_replay', replayEvents: p.replay.length },
    });
  } else {
    for (const event of replay) writeFrame(res, event);
  }
  p.subscribers.add(res);
  const drop = () => p.subscribers.delete(res);
  req.on('close', drop);
  res.on('close', drop);
}

// Liquidsoap's sampling loop: levels about once a second, position every
// second, heartbeat every ten.
function tick() {
  const now = Date.now();
  for (const p of programs.values()) {
    // As in Palazzo, every one of these comes from a Liquidsoap sample: with Liquidsoap down there is none.
    if (p.liquidsoapDown) continue;
    p.lastSampleAt = new Date(now).toISOString();
    emit(p, 'audio.levels', levels(p));
    emit(p, 'playback.position', {
      playbackRequestId: p.track?.playbackRequestId ?? null,
      positionSeconds: positionSeconds(p),
      remainingSeconds: playbackState(p).remainingSeconds,
      status: p.track ? 'playing' : 'idle',
    });
    if (now - p.lastHeartbeatAt >= CONFIG.heartbeatMs) {
      p.lastHeartbeatAt = now;
      emit(p, 'heartbeat', { liquidsoapSequence: p.liquidsoapSequence });
    }
  }
}

// ---------------------------------------------------------------------------
// Playout
// ---------------------------------------------------------------------------

function trackLength(song) {
  const segue = song.segue;
  if (
    segue &&
    Number.isFinite(segue.cueOutSeconds) &&
    Number.isFinite(segue.cueInSeconds) &&
    segue.cueOutSeconds > segue.cueInSeconds
  )
    return segue.cueOutSeconds - segue.cueInSeconds;
  return CONFIG.trackSeconds > 0 ? CONFIG.trackSeconds : null;
}

function lifecycleData(p, song) {
  p.liquidsoapSequence += 1;
  return {
    playbackRequestId: song.playbackId,
    title: song.title || null,
    artist: song.artist || null,
    coverUrl: song.coverUrl || null,
    liquidsoapSequence: p.liquidsoapSequence,
  };
}

function startTrack(p, song, intro) {
  const occurredAt = new Date().toISOString();
  p.track = {
    playbackRequestId: song.playbackId,
    title: song.title || null,
    artist: song.artist || null,
    coverUrl: song.coverUrl || null,
    url: song.url,
    startedAt: occurredAt,
  };
  p.trackStartedMs = Date.now();
  p.trackLengthSeconds = trackLength(song);
  const data = lifecycleData(p, song);
  emit(p, 'track.started', data, occurredAt);
  emit(p, 'playout.started', {
    playbackRequestId: song.playbackId,
    playbackId: song.playbackId,
    programId: p.programId,
    liquidsoapSequence: data.liquidsoapSequence,
  }, occurredAt);
  if (p.lastEnded && Date.now() - p.lastEnded.atMs <= SONG_CHANGE_WINDOW_MS) {
    emit(p, 'playout.transitioned', {
      fromPlaybackId: p.lastEnded.playbackId,
      toPlaybackId: song.playbackId,
      programId: p.programId,
      liquidsoapSequence: data.liquidsoapSequence,
    }, occurredAt);
  }
  p.lastEnded = null;
  if (intro?.url) {
    p.intro = {
      playbackId: intro.playbackId,
      parentPlaybackId: song.playbackId,
      programId: p.programId,
      playbackRequestId: song.playbackId,
      url: intro.url,
      startedAt: occurredAt,
      status: 'playing',
    };
    emit(p, 'intro.started', {
      ...data,
      playbackId: intro.playbackId,
      parentPlaybackId: song.playbackId,
      programId: p.programId,
    }, occurredAt);
    p.introTimer = setTimeout(() => endIntro(p), CONFIG.introSeconds * 1000);
  }
  if (p.trackLengthSeconds !== null) {
    p.trackTimer = setTimeout(() => naturalEnd(p), p.trackLengthSeconds * 1000);
  }
}

function endIntro(p) {
  clearTimeout(p.introTimer);
  p.introTimer = null;
  if (!p.intro) return;
  const intro = p.intro;
  p.intro = null;
  p.liquidsoapSequence += 1;
  emit(p, 'intro.ended', {
    playbackRequestId: intro.playbackRequestId,
    title: p.track?.title ?? null,
    artist: p.track?.artist ?? null,
    coverUrl: p.track?.coverUrl ?? null,
    liquidsoapSequence: p.liquidsoapSequence,
    playbackId: intro.playbackId,
    parentPlaybackId: intro.parentPlaybackId,
    programId: p.programId,
  });
}

function endTrack(p, reason) {
  clearTimeout(p.trackTimer);
  p.trackTimer = null;
  if (p.intro) endIntro(p);
  if (!p.track) return;
  const track = p.track;
  p.track = null;
  p.trackLengthSeconds = null;
  const occurredAt = new Date().toISOString();
  const data = lifecycleData(p, {
    playbackId: track.playbackRequestId,
    title: track.title,
    artist: track.artist,
    coverUrl: track.coverUrl,
  });
  emit(p, 'track.ended', data, occurredAt);
  const common = {
    playbackRequestId: track.playbackRequestId,
    playbackId: track.playbackRequestId,
    programId: p.programId,
    liquidsoapSequence: data.liquidsoapSequence,
  };
  if (reason === 'replacement') {
    emit(p, 'playout.skipped', { ...common, reason }, occurredAt);
  } else {
    emit(p, 'playout.stopped', { ...common, reason }, occurredAt);
  }
  p.lastEnded = { playbackId: track.playbackRequestId, atMs: Date.now() };
}

function naturalEnd(p) {
  endTrack(p, 'natural_end');
  const next = p.next;
  p.next = null;
  if (!next) return;
  if (next.bumper && CONFIG.capabilities.includes('next.bumper')) {
    startInstant(p, next.bumper.playbackId, () => startTrack(p, next.song));
  } else {
    startTrack(p, next.song);
  }
}

function withdrawNext(p, reason) {
  if (!p.next) return false;
  const next = p.next;
  p.next = null;
  emit(p, 'playout.next_withdrawn', {
    programId: p.programId,
    playbackId: next.song.playbackId,
    reason,
  });
  return true;
}

function startInstant(p, playbackId, onEnd) {
  const timer = setTimeout(() => {
    if (!p.instants.has(playbackId)) return;
    p.instants.delete(playbackId);
    emit(p, 'instant.ended', { programId: p.programId, playbackId });
    onEnd?.();
  }, CONFIG.instantSeconds * 1000);
  p.instants.set(playbackId, timer);
  emit(p, 'instant.started', { programId: p.programId, playbackId });
}

function stopInstants(p) {
  for (const [playbackId, timer] of p.instants) {
    clearTimeout(timer);
    p.instants.delete(playbackId);
    emit(p, 'instant.ended', { programId: p.programId, playbackId });
  }
}

function clearProgramMaterial(p) {
  clearTimeout(p.pendingStart);
  p.pendingStart = null;
  withdrawNext(p, 'flushed');
  endTrack(p, 'operator');
  stopInstants(p);
}

// Palazzo's startFromPlaybackCommand: a song command reconciles the
// lifecycle to running.
function startFromPlaybackCommand(p) {
  const l = p.lifecycle;
  if (l.actualState !== 'ready') {
    const stamp = new Date().toISOString();
    l.requestedState = 'running';
    l.actualState = 'ready';
    l.timestamps.requestedAt = stamp;
    l.timestamps.readyAt = stamp;
  }
  if (CONFIG.bindFillerOnPlayback && !p.activeFiller && p.fillers.size) {
    const newest = [...p.fillers.values()].at(-1);
    p.activeFiller = newest.version;
    p.boundBy = 'fallback';
  }
}

function requireReady(p) {
  if (p.lifecycle.actualState !== 'ready') {
    throw new HttpError(409, {
      error: 'automation is not ready',
      lifecycle: lifecycleState(p),
    });
  }
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function bounded(value, max) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max;
}

function requireKey(req) {
  const key = header(req, 'idempotency-key')?.trim() ?? '';
  if (!key || key.length > 200)
    throw new HttpError(400, 'a bounded Idempotency-Key is required');
  return key;
}

function validateAsset(p, asset, kind) {
  if (!asset || typeof asset !== 'object')
    throw new HttpError(400, `${kind} is required`);
  if (asset.programId !== p.programId)
    throw new HttpError(400, `${kind} belongs to another program`);
  if (!bounded(asset.playbackId, 200))
    throw new HttpError(400, `${kind}.playbackId is invalid`);
  if (!bounded(asset.url, 4096)) throw new HttpError(400, `${kind}.url is required`);
  return asset;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonical(value[key])]),
  );
}

function fingerprint(value) {
  return JSON.stringify(canonical(value));
}

function digest(key) {
  return createHash('sha256').update(key).digest('hex');
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

function playSong(p, req, body) {
  const key = requireKey(req);
  const song = validateAsset(p, body?.song, 'song');
  const intro = body?.intro ? validateAsset(p, body.intro, 'intro') : undefined;
  const print = fingerprint(body);
  const prior = p.songCommands.get(digest(key));
  if (prior) {
    if (prior.fingerprint !== print)
      throw new HttpError(400, 'idempotency key was already used for another playout');
    return {
      ok: true,
      playbackRequestId: prior.playbackRequestId,
      introPlaybackId: prior.introPlaybackId,
      duplicate: true,
    };
  }
  startFromPlaybackCommand(p);
  const scheduledAt = new Date().toISOString();
  emit(p, 'playout.queued', {
    programId: p.programId,
    playbackId: song.playbackId,
    kind: 'song',
    scheduledAt,
  });
  if (intro) {
    emit(p, 'playout.queued', {
      programId: p.programId,
      playbackId: intro.playbackId,
      kind: 'intro',
      scheduledAt,
    });
  }
  const record = {
    fingerprint: print,
    playbackRequestId: song.playbackId,
    introPlaybackId: intro ? intro.playbackId : null,
  };
  p.songCommands.set(digest(key), record);
  if (p.songCommands.size > 256)
    p.songCommands.delete(p.songCommands.keys().next().value);
  clearTimeout(p.pendingStart);
  // Liquidsoap picks the request up shortly after the answer.
  p.pendingStart = setTimeout(() => {
    p.pendingStart = null;
    withdrawNext(p, 'flushed');
    endTrack(p, 'replacement');
    startTrack(p, song, intro);
  }, CONFIG.startDelayMs);
  return {
    ok: true,
    playbackRequestId: song.playbackId,
    introPlaybackId: record.introPlaybackId,
    duplicate: false,
  };
}

function announceNext(p, req, body) {
  const key = requireKey(req);
  const song = validateAsset(p, body?.song, 'song');
  const bumper = body?.bumper;
  if (bumper !== undefined && (!bounded(bumper?.playbackId, 200) || !bounded(bumper?.url, 4096)))
    throw new HttpError(400, 'bumper is invalid');
  const print = fingerprint(body);
  const prior = p.nextCommands.get(digest(key));
  if (prior) {
    if (prior.fingerprint !== print)
      throw new HttpError(400, 'idempotency key was already used for another announcement');
    return { ok: true, playbackRequestId: song.playbackId, state: 'queued', duplicate: true };
  }
  if (!p.track) throw new HttpError(409, { error: 'no current song', result: 'no_current_song' });
  if (p.next && p.next.song.playbackId !== song.playbackId) withdrawNext(p, 'replaced');
  p.next = { song, bumper };
  p.nextCommands.set(digest(key), { fingerprint: print });
  if (p.nextCommands.size > 256)
    p.nextCommands.delete(p.nextCommands.keys().next().value);
  emit(p, 'playout.next_queued', { programId: p.programId, playbackId: song.playbackId });
  return { ok: true, playbackRequestId: song.playbackId, state: 'queued', duplicate: false };
}

function playInstant(p, body) {
  requireReady(p);
  if (!bounded(body?.url, 4096)) throw new HttpError(400, 'url is required');
  if (body.programId !== p.programId)
    throw new HttpError(400, 'instant belongs to another program');
  if (!bounded(body.playbackId, 200)) throw new HttpError(400, 'playbackId is invalid');
  if (p.instants.has(body.playbackId)) {
    clearTimeout(p.instants.get(body.playbackId));
    p.instants.delete(body.playbackId);
  }
  startInstant(p, body.playbackId);
  return { ok: true, playbackRequestId: body.playbackId };
}

function updateMixer(p, body) {
  requireReady(p);
  if (!body || typeof body !== 'object') throw new HttpError(400, 'mixer is required');
  const next = { ...p.mixer };
  for (const field of ['mainVolume', 'songVolume', 'instantVolume']) {
    if (body[field] === undefined) continue;
    const value = body[field];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 2)
      throw new HttpError(400, `${field} must be a finite gain between 0 and 2`);
    next[field] = value;
  }
  for (const field of ['songMuted', 'instantMuted']) {
    if (body[field] === undefined) continue;
    if (typeof body[field] !== 'boolean') throw new HttpError(400, `${field} must be a boolean`);
    next[field] = body[field];
  }
  p.mixer = next;
  return { ...p.mixer };
}

function prepareFiller(p, version, body) {
  if (!IDENTIFIER.test(version)) throw new HttpError(400, 'invalid-version');
  const existing = p.fillers.get(version);
  if (existing) return existing;
  const mode = body?.mode ?? 'ordered';
  if (mode !== 'ordered' && mode !== 'shuffle') throw new HttpError(400, 'invalid-mode');
  if (mode === 'shuffle' && !bounded(body?.shuffleSeed, 128))
    throw new HttpError(400, 'invalid-shuffle-seed');
  const assets = body?.assets;
  if (!Array.isArray(assets) || assets.length < 1 || assets.length > 100)
    throw new HttpError(400, 'invalid-assets');
  const ids = new Set();
  for (const asset of assets) {
    if (
      !asset ||
      !IDENTIFIER.test(asset.id ?? '') ||
      !SHA256.test(asset.sha256 ?? '') ||
      !bounded(asset.downloadUrl, 4096) ||
      ids.has(asset.id)
    )
      throw new HttpError(400, 'invalid-asset');
    ids.add(asset.id);
  }
  // Real Palazzo downloads, verifies and normalizes each asset. The fake never
  // downloads anything: it trusts the declared checksum.
  const manifest = {
    version,
    status: 'ready',
    ready: true,
    mode,
    ...(mode === 'shuffle' ? { shuffleSeed: body.shuffleSeed } : {}),
    assets: assets.map((asset) => ({
      id: asset.id,
      sourceSha256: asset.sha256,
      artifactSha256: digest(`fake-palazzo:${asset.sha256}`),
      durationSeconds: CONFIG.trackSeconds,
    })),
    preparedAt: new Date().toISOString(),
  };
  p.fillers.set(version, manifest);
  return manifest;
}

function getFiller(p, version) {
  if (!IDENTIFIER.test(version)) throw new HttpError(400, 'invalid-version');
  return p.fillers.get(version) ?? { version, status: 'unprepared', ready: false };
}

function commandAutomation(p, req, action) {
  const l = p.lifecycle;
  const key = header(req, 'idempotency-key')?.trim() ?? '';
  const sequence = Number(header(req, 'x-command-sequence'));
  const fillerVersion = action === 'start' ? header(req, 'x-filler-version')?.trim() || null : null;
  if (!key || key.length > 200)
    throw new HttpError(400, 'a bounded Idempotency-Key is required');
  if (!Number.isInteger(sequence) || sequence < 1)
    throw new HttpError(400, 'X-Command-Sequence must be a positive integer');
  const id = digest(key);
  const prior = l.commands.get(id);
  if (prior) {
    if (prior.action !== action || prior.sequence !== sequence || prior.fillerVersion !== fillerVersion)
      throw new HttpError(409, 'idempotency key was already used for another command');
    return { ...lifecycleState(p), commandResult: { ...prior, duplicate: true } };
  }
  if (sequence <= l.lastSequence) {
    throw new HttpError(409, {
      error: 'command sequence is not newer than the last accepted command',
      lastAcceptedSequence: l.lastSequence,
    });
  }
  const stamp = new Date().toISOString();
  if (action === 'start') {
    if (!fillerVersion) throw new HttpError(400, 'X-Filler-Version is required');
    if (!p.fillers.has(fillerVersion) && !CONFIG.acceptUnpreparedFiller)
      throw new HttpError(409, 'requested filler version is not prepared');
    if (
      l.requestedState === 'running' &&
      p.activeFiller &&
      p.activeFiller !== fillerVersion &&
      p.boundBy !== 'fallback'
    )
      throw new HttpError(409, 'active session filler version is immutable');
    p.activeFiller = fillerVersion;
    p.boundBy = 'start';
    l.requestedState = 'running';
    l.actualState = 'ready';
    l.timestamps.requestedAt = stamp;
    l.timestamps.readyAt = stamp;
    if (CONFIG.fillerClearsSilence) p.silent = false;
  } else {
    clearProgramMaterial(p);
    p.activeFiller = null;
    p.boundBy = null;
    l.requestedState = 'stopped';
    l.actualState = 'stopped';
    l.timestamps.requestedAt = stamp;
    l.timestamps.stoppedAt = stamp;
  }
  const record = {
    id: id.slice(0, 16),
    action,
    sequence,
    result: action === 'start' ? 'ready' : 'stopped',
    status: 200,
    acceptedAt: stamp,
    fillerVersion,
  };
  l.lastSequence = sequence;
  l.lastCommand = record;
  l.commands.set(id, record);
  if (l.commands.size > 256) l.commands.delete(l.commands.keys().next().value);
  return { ...lifecycleState(p), commandResult: record };
}

// A continuous 8 kHz mono 16-bit WAV stream: a quiet tone while the output is
// audible, digital silence while it is not.
function outputAudio(p, req, res) {
  const rate = 8000;
  const headerBuffer = Buffer.alloc(44);
  headerBuffer.write('RIFF', 0);
  headerBuffer.writeUInt32LE(0xffffffff, 4);
  headerBuffer.write('WAVE', 8);
  headerBuffer.write('fmt ', 12);
  headerBuffer.writeUInt32LE(16, 16);
  headerBuffer.writeUInt16LE(1, 20);
  headerBuffer.writeUInt16LE(1, 22);
  headerBuffer.writeUInt32LE(rate, 24);
  headerBuffer.writeUInt32LE(rate * 2, 28);
  headerBuffer.writeUInt16LE(2, 32);
  headerBuffer.writeUInt16LE(16, 34);
  headerBuffer.write('data', 36);
  headerBuffer.writeUInt32LE(0xffffffff, 40);
  res.writeHead(200, {
    'Content-Type': 'audio/wav',
    'Cache-Control': 'no-store',
    'X-Accel-Buffering': 'no',
  });
  res.write(headerBuffer);
  let phase = 0;
  const chunkSamples = rate / 10;
  const timer = setInterval(() => {
    const rms = levels(p).output.rms;
    const amplitude = Math.min(1, rms * Math.SQRT2) * 0.5 * 32767;
    const chunk = Buffer.alloc(chunkSamples * 2);
    for (let i = 0; i < chunkSamples; i += 1) {
      chunk.writeInt16LE(Math.round(amplitude * Math.sin(phase)), i * 2);
      phase += (2 * Math.PI * 440) / rate;
    }
    res.write(chunk);
  }, 100);
  const stop = () => clearInterval(timer);
  req.on('close', stop);
  res.on('close', stop);
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

function header(req, name) {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 1024 * 1024) {
        reject(new HttpError(413, 'body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function parseJson(text) {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'invalid JSON body');
  }
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
  });
  res.end(text);
}

function record(req, path, body, status) {
  const headers = {};
  for (const name of LOGGED_HEADERS) {
    const value = header(req, name);
    if (value !== undefined) headers[name] = value;
  }
  logCounter += 1;
  requestLog.push({
    n: logCounter,
    at: new Date().toISOString(),
    method: req.method,
    path,
    headers,
    body: body ?? null,
    status,
  });
  if (requestLog.length > CONFIG.logLimit) requestLog.shift();
}

async function route(req, res, url) {
  const path = url.pathname;
  const method = req.method;

  // Control surface, outside Palazzo's contract.
  if (path === '/__fake/health' && method === 'GET') {
    return sendJson(res, 200, { ok: true, programs: [...programs.keys()] });
  }
  if (path === '/__fake/log') {
    if (method === 'GET') {
      const since = Number(url.searchParams.get('since') ?? 0) || 0;
      return sendJson(res, 200, { entries: requestLog.filter((entry) => entry.n > since) });
    }
    if (method === 'DELETE') {
      requestLog.length = 0;
      return sendJson(res, 200, { ok: true });
    }
  }
  const control = /^\/__fake\/programs\/([^/]+)(\/[a-z-]+)?$/.exec(path);
  if (control) {
    const programId = decodeURIComponent(control[1]);
    if (!PROGRAM_ID.test(programId)) throw new HttpError(400, 'invalid programId');
    const p = program(programId);
    const action = control[2] ?? '';
    const body = parseJson(await readBody(req));
    let answer;
    if (action === '' && method === 'GET') {
      answer = {
        silent: p.silent,
        eventsMuted: p.liquidsoapDown,
        state: playbackState(p),
        automation: lifecycleState(p),
        next: p.next ? { playbackId: p.next.song.playbackId, bumper: p.next.bumper ?? null } : null,
        instants: [...p.instants.keys()],
        fillers: [...p.fillers.values()],
        mixer: p.mixer,
        subscribers: p.subscribers.size,
      };
    } else if (action === '/silence' && method === 'POST') {
      if (typeof body?.silent !== 'boolean') throw new HttpError(400, 'silent must be a boolean');
      p.silent = body.silent;
      answer = { ok: true, silent: p.silent };
    } else if (action === '/mute-events' && method === 'POST') {
      // Palazzo with Liquidsoap down (gaulatti/palazzo playback-telemetry.service.ts markDisconnected): one
      // telemetry.disconnected, then a silent event stream, while the HTTP API, the state endpoint included,
      // still answers. Unmuting is Liquidsoap coming back: telemetry.connected, then the sampling loop again.
      if (typeof body?.muted !== 'boolean') throw new HttpError(400, 'muted must be a boolean');
      if (body.muted && !p.liquidsoapDown) {
        p.liquidsoapDown = true;
        p.staleSince = new Date().toISOString();
        emit(p, 'telemetry.disconnected', { staleSince: p.staleSince });
      } else if (!body.muted && p.liquidsoapDown) {
        p.liquidsoapDown = false;
        p.staleSince = null;
        emit(p, 'telemetry.connected', {});
      }
      answer = { ok: true, muted: p.liquidsoapDown };
    } else if (action === '/end-track' && method === 'POST') {
      clearTimeout(p.pendingStart);
      naturalEnd(p);
      answer = { ok: true };
    } else {
      throw new HttpError(404, 'unknown control route');
    }
    if (method !== 'GET') record(req, path, body, 200);
    return sendJson(res, 200, answer);
  }

  const match = /^\/v1\/programs\/([^/]+)(\/.*)$/.exec(path);
  if (!match) throw new HttpError(404, 'not found');
  const programId = decodeURIComponent(match[1]);
  if (!PROGRAM_ID.test(programId)) throw new HttpError(400, 'invalid programId');
  const p = program(programId);
  const sub = match[2];

  if (sub === '/playback/events' && method === 'GET') {
    record(req, path, null, 200);
    return subscribe(p, req, res);
  }
  if (sub === '/output/audio' && method === 'GET') {
    record(req, path, null, 200);
    return outputAudio(p, req, res);
  }

  const body = parseJson(await readBody(req));
  let answer;
  try {
    answer = handleProgramRoute(p, req, method, sub, body);
  } catch (error) {
    record(req, path, body, error instanceof HttpError ? error.status : 500);
    throw error;
  }
  record(req, path, body, 200);
  return sendJson(res, 200, answer);
}

function handleProgramRoute(p, req, method, sub, body) {
  const filler = /^\/fillers\/([^/]+)$/.exec(sub);
  if (filler) {
    const version = decodeURIComponent(filler[1]);
    if (method === 'PUT') return prepareFiller(p, version, body);
    if (method === 'GET') return getFiller(p, version);
  }
  const key = `${method} ${sub}`;
  switch (key) {
    case 'POST /playback/song':
      return playSong(p, req, body);
    case 'PUT /playback/next':
      return announceNext(p, req, body);
    case 'DELETE /playback/next':
      return { ok: true, withdrawn: withdrawNext(p, 'withdrawn') };
    case 'POST /playback/song/stop':
      clearTimeout(p.pendingStart);
      p.pendingStart = null;
      withdrawNext(p, 'flushed');
      endTrack(p, 'operator');
      return { ok: true };
    case 'POST /playback/instant':
      return playInstant(p, body);
    case 'POST /playback/instant/stop':
      stopInstants(p);
      return { ok: true };
    case 'GET /mixer':
      return { ...p.mixer };
    case 'PUT /mixer':
      return updateMixer(p, body);
    case 'GET /playback/state':
      return playbackState(p);
    case 'GET /automation':
      return lifecycleState(p);
    case 'POST /automation/start':
      return commandAutomation(p, req, 'start');
    case 'POST /automation/stop':
      return commandAutomation(p, req, 'stop');
    default:
      throw new HttpError(404, 'not found');
  }
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://fake-palazzo.invalid');
  route(req, res, url).catch((error) => {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    if (error instanceof HttpError) return sendJson(res, error.status, error.body);
    console.error('fake-palazzo: unhandled error', error);
    return sendJson(res, 500, { error: 'internal error' });
  });
});

/**
 * Starts the fake on `port` (0 picks a free one) and resolves once it listens. The level ticker runs
 * while it listens; `close()` stops both.
 */
export function startFakePalazzo({ port = CONFIG.port, host = CONFIG.host } = {}) {
  const ticker = setInterval(tick, CONFIG.levelsIntervalMs);
  return new Promise((resolve) => {
    server.listen(port, host, () =>
      resolve({
        server,
        port: server.address().port,
        close: () =>
          new Promise((done) => {
            clearInterval(ticker);
            for (const p of programs.values()) {
              for (const res of p.subscribers) res.end();
              p.subscribers.clear();
              clearTimeout(p.trackTimer);
              clearTimeout(p.introTimer);
              clearTimeout(p.pendingStart);
              for (const timer of p.instants.values()) clearTimeout(timer);
            }
            server.closeAllConnections?.();
            server.close(() => done());
            // A connection that lingers past the close must not hold the caller.
            setTimeout(done, 1000).unref();
          }),
      }),
    );
  });
}

// Run directly (the Compose `fake-palazzo` profile): listen on PORT and stop on a signal.
if (import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const running = await startFakePalazzo();
  console.log(
    `fake-palazzo listening on ${CONFIG.host}:${running.port} ` +
      `(redactUrls=${CONFIG.redactUrls}, capabilities=[${CONFIG.capabilities.join(',')}], ` +
      `trackSeconds=${CONFIG.trackSeconds}, levelsIntervalMs=${CONFIG.levelsIntervalMs})`,
  );
  const shutdown = (signal) => {
    console.log(`fake-palazzo: ${signal}, shutting down`);
    void running.close().then(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
