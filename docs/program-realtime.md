# Program realtime delivery

Every `GET /program/{programId}/events` SSE connection is an independent
subscriber. The backend subscribes it to live program events before reading
state, sends a complete `program_state_snapshot`, and then flushes any events
that arrived while the snapshot was loading. This ordering prevents a newly
loaded renderer from missing a transition between its initial read and live
subscription.

The `/program/{programId}` renderer and its backend reads are public. The
frontend authentication interceptor must leave every backend request from that
document untouched; authorization remains required for Control and all Program
mutations. This keeps unattended broadcast renderers independent of an operator
login session without weakening protected API boundaries.

Control treats SSE as the authoritative channel and keeps it connected whenever
the console is open. The console does not attempt WebSocket during the initial
SSE handshake. The authenticated control WebSocket connects only after SSE
reports a failure, and the five-second HTTP snapshot loop runs only while both
realtime channels are unavailable. Control may consume an initial
`program_state_snapshot` from either realtime transport during a handoff. The
SSE snapshot must hydrate the scene strip and active/staged monitors, not merely
advance the shared state-version watermark; otherwise an SSE-first startup can
discard an equal-version fallback snapshot and leave the console empty.

Meter, playback, scene, audio-bus, and persisted `song_queue_update` events
share that SSE stream. Play Next queue updates use the audio-bus version
watermark, so an HTTP mutation response and its matching realtime event are
idempotent. Palazzo's
default 10 Hz level samples therefore reach the console continuously instead of
waiting for the HTTP fallback interval. Topic-specific version watermarks make
the brief SSE/WebSocket handoff idempotent.

The SSE response sets `X-Accel-Buffering: no` so nginx forwards events without
buffering. Program renderers also reconcile the public state, audio-bus,
broadcast-settings, scene-instant, and stinger snapshots immediately and every
five seconds, including while the document is hidden. Polling is reconciliation
for an open renderer, not exclusive ownership or a replacement for SSE.

Generic slideshow scenes eagerly preload every media-group image and advance
only among frames that have finished loading. This is required for offscreen
broadcast renderers, which may indefinitely defer opacity-hidden lazy images.

The private Prometheus endpoint exposes:

- `alcantara_program_sse_connections`: currently open program SSE subscribers.
- `alcantara_program_sse_snapshots_total{result}`: initial snapshot outcomes;
  `result` is bounded to `success`, `failure`, or `unknown`.
- `alcantara_program_playing_track_cover_lookups_total{result}`: song-record
  cover lookups for a confirmed playing track (gaulatti/alcantara#179), one per
  accepted start that carries an audio URL. `result` is exactly one of:
  - `included`: the stored cover is a public https URL and rides `playingTrack.coverUrl`;
  - `absent`: no song record matches, or the record stores no cover;
  - `rejected`: a stored value was refused, for example http, malformed, a non-public address or a bare hostname;
  - `error`: the database lookup failed.

  All four series are exposed at zero from the first scrape. A rising `error`
  rate means covers are being dropped because the database read fails, and
  `rejected` points at catalogue entries with an unusable cover URL.

## Staged video streams are warm before a take (#357)

A staged scene that includes a `video-stream` is rendered on the program page
ahead of time, hidden (opacity 0, `aria-hidden`) and muted, so its stream is
already playing when it goes on air.

The on-air scene and the warm staged scene are sibling layers under one parent,
keyed by scene id and kept in id order.
- **A take swaps them:** the staged scene goes on air, and the one it replaces
  becomes staged.
- **The promoted scene keeps its mounted tree:** only its opacity, stacking and
  stream gain change. Its HLS player is not created again, and no playing
  element moves in the page.
- **The replaced scene stays mounted,** hidden and muted, if it has a stream, so
  the cut back is warm too.

A staged scene without a stream is not rendered ahead of time. The page renders
at most these two scenes.

Measured on the local stack, with a stream whose every response took 800 ms (as
a remote CDN might), cutting to the staged stream scene:
- the first stream frame arrived 1,099 ms after the cut before this change;
- with this change it arrived 37 ms after the cut, with no black frame in between.
