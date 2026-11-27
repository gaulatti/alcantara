# Fake Palazzo (local only)

A local, in-memory stand-in for Palazzo, the radio playout engine, so the Radio desk, output confidence and radio
recovery can be walked on the Compose stack. It is plain Node with no dependencies
(`backend/test/fixtures/fake-palazzo-server.mjs`). It never contacts another host: songs and filler assets are not
downloaded. It holds no credentials and is not a production component.

## Run it

It runs only under the opt-in `fake-palazzo` Compose profile:

```bash
docker compose --profile fake-palazzo up --build
```

- **Address.** The `palazzo` service answers at `http://palazzo:3100`, the address `PALAZZO_ALLOWED_URLS` already
  names in `compose.yml`. No port is published.
- **Default stack.** Without the profile, nothing starts it, and no other service depends on it.
- **Shipping.** `backend/test/fake-palazzo.test.mjs` (part of `test:deployment`) checks that no deploy script,
  workflow, infrastructure file or production Dockerfile names it.
- **Enable radio first.** The seed turns radio off for `main` and `radio-demo`. Enable it in **Radio settings**;
  Alcántara then starts its Palazzo telemetry client against the fake.
- **Control routes.** Call them from inside the network, for example
  `docker compose exec palazzo wget -qO- http://127.0.0.1:3100/__fake/log`. Use `127.0.0.1`: inside the container
  `localhost` resolves to IPv6 first, which the fake does not listen on, so `wget` is refused.

## A dead-air walk

1. **Play a song** on the Radio desk. Output confidence reads detected: `audio.levels` carries an output level of
   about 0.2.
2. **Make the output silent** while the track keeps playing:
   ```bash
   docker compose exec palazzo wget -qO- --header 'Content-Type: application/json' \
     --post-data '{"silent":true}' http://127.0.0.1:3100/__fake/programs/radio-demo/silence
   ```
   After 10 s below 0.001 RMS, output confidence reads silent and the desk shows dead air.
3. **Prepare a recovery playlist** in Radio settings (**Prepared local playlist**). The fake answers `ready`
   without downloading anything. The songs must be on the managed bucket or, locally, the local media store.
4. **Press Start with fallback.** The fake binds the version and reports `filler.ready: true`.
5. **Hold Stop session.** The fake clears program audio and unbinds the filler.
6. **See what Alcántara sent** with `GET /__fake/log`.

## A dead-air watchdog walk

The backend's dead-air watchdog ([Radio station workflow](radio-station-workflow.md), "Dead-air watchdog") acts only
on an autoplay or shuffle rotation, so the manual walk above never triggers it. On `radio-demo.fm`, with radio enabled
and the rotation on **Shuffle**, run each step with the program's control routes and read `GET /__fake/log`. Each step
watches the desk's Dead air advice and the backend's `/metrics` (`alcantara_radio_dead_air_*`).

```bash
fake() { docker compose exec palazzo wget -qO- --header 'Content-Type: application/json' --post-data "$2" "http://127.0.0.1:3100/__fake/programs/radio-demo.fm/$1"; }
fake silence '{"silent":true}'      # dead air while the track keeps playing
fake silence '{"silent":false}'     # heard again
fake live '{"onAir":true}'          # the live input on air; '{"onAir":null}' stops reporting it
```

1. **Recovered by the replay.** Make the output silent. About 20 s later the log shows one `POST /playback/song` with
   the same song and a new playback id, and the advice says "Automatic recovery played the song again from its
   start." Clear the silence: `resend`/`recovered` counts 1 and nothing else is sent.
2. **Not recovered.** Leave it silent. It plays the song again, then about 20 s after that replay starts it sends
   the next song's command, then about 20 s later it gives up. The advice leads with "Dead air: could not recover",
   and `alcantara_radio_dead_air_unrecovered_programs` reads 1 until the silence clears.
3. **Live input.** Set `live` on air, then `null`, then cue a guest live: no command is sent, and the advice says what
   holds it.
4. **Stop, freeze, lost readings.** Hold Stop, then make the output silent: nothing is sent, because the rotation is
   manual. `mute-events` (state unknown) sends nothing either.
5. **Mixer.** Mute Music on the desk, then make the output silent: nothing is sent, and the mixer is left alone.
6. **A replay that goes silent again** is moved past, never played again a second time.
7. **A fourth episode within the hour** goes straight to giving up.

## Routes

Every contract route lives under `/v1/programs/{programId}`, for any valid
program id. Each program gets its own state, its own `instanceId`
(`fake-palazzo-{programId}`) and its own `bootId`. All state is lost when the
fake restarts.

| Route | Answer |
| --- | --- |
| `POST /playback/song` | `{ok, playbackRequestId, introPlaybackId, duplicate}`. Requires `Idempotency-Key`; a reused key with another body gets 400. Moves the lifecycle to running/ready, as Palazzo's `startFromPlaybackCommand` does. Emits `playout.queued`, then after 300 ms `track.started` and `playout.started` (and `playout.transitioned` within 5 s of an end). A song already playing ends first with `playout.skipped`. With an intro, `intro.started` then `intro.ended`. |
| `PUT /playback/next` | `{ok, playbackRequestId, state: "queued", duplicate}`; 409 when nothing plays. Emits `playout.next_queued`. At the track's end the announced song starts; with a `bumper`, a spot plays first (`instant.started`/`ended`). |
| `DELETE /playback/next` | `{ok, withdrawn}`, with `playout.next_withdrawn` (`withdrawn`). A song command or a stop flushes it (`flushed`); a different announcement replaces it (`replaced`). |
| `POST /playback/song/stop` | `{ok: true}`. `track.ended` and `playout.stopped` (`operator`). |
| `POST /playback/instant` | `{ok, playbackRequestId}`, with `instant.started`, then `instant.ended` 3 s later. 409 `automation is not ready` until the lifecycle is ready, as in Palazzo. |
| `POST /playback/instant/stop` | `{ok: true}`. Ends every instant. |
| `GET /mixer`, `PUT /mixer` | The mixer state. `PUT` needs the lifecycle ready (409 otherwise) and gains between 0 and 2. The mixer scales the reported output level. |
| `GET /playback/state` | The full playback state, schema version 1, with URLs. `live` as the `live` control route set it (default `{onAir: false}`), `capabilities` from `FAKE_CAPABILITIES`. |
| `GET /playback/events` | SSE. A `snapshot` first, then `audio.levels` and `playback.position` every second, `heartbeat` every 10 s, and the lifecycle events. Ids are `bootId:sequence`, with one contiguous sequence per program. `Last-Event-ID` inside the 512-event window replays from the snapshot at that cursor; an unknown cursor gets the current snapshot, then `replay.gap`. |
| `GET /output/audio` | `audio/wav`: an endless 8 kHz mono stream. A quiet 440 Hz tone while output is audible, digital silence otherwise. |
| `PUT /fillers/{version}` | `{version, status: "ready", ready: true, mode, assets[], preparedAt}`. Validates 1 to 100 assets with a 64-hex `sha256`. Nothing is downloaded. |
| `GET /fillers/{version}` | The manifest, or `{version, status: "unprepared", ready: false}`. |
| `GET /automation` | Palazzo's lifecycle shape: `requestedState`, `actualState`, `readiness`, `filler {activeVersion, ready, boundBy}`, `lastSequence`, `lastCommand`, `playback`. It starts at `reconciliation-required`. |
| `POST /automation/start` | Requires `Idempotency-Key`, `X-Command-Sequence` above the last one, and `X-Filler-Version` of a prepared version. A replayed key is answered as a duplicate; an older sequence gets 409. Binds the filler (`boundBy: "start"`) and answers the lifecycle with `readiness: true` plus `commandResult`. |
| `POST /automation/stop` | Same headers, minus the filler version. Clears program audio and instants, unbinds the filler, and sets the state to stopped/stopped. |

### Control routes (outside the contract)

| Route | Effect |
| --- | --- |
| `GET /__fake/health` | `{ok: true, programs}` |
| `POST /__fake/programs/{id}/silence` `{"silent": true\|false}` | Dead air: every level, output included, reads 0 while the track keeps playing. |
| `POST /__fake/programs/{id}/live` `{"onAir": true\|false\|null}` | Palazzo's live input (a guest or the host mic pushed by the contribution worker): on air, off, or not reported (`null` leaves `live` out of the state, as a Palazzo that does not report it). Default off. |
| `POST /__fake/programs/{id}/mute-events` `{"muted": true\|false}` | Liquidsoap down, as Palazzo reports it (#734): one `telemetry.disconnected`, then nothing on the event stream (no levels, position or heartbeat), while every HTTP route still answers and the state reads `liquidsoap.connected: false` with a `staleSince`. A reconnect still gets its snapshot. Unmuting emits `telemetry.connected` and the stream resumes. |
| `POST /__fake/programs/{id}/end-track` | Ends the current track now, as a natural end, and goes into any announced song. |
| `GET /__fake/programs/{id}` | Internal state: silence flag, playback, automation, next, instants, fillers, mixer, subscriber count. |
| `GET /__fake/log[?since=n]` | The requests received: `n`, `at`, `method`, `path`, selected headers (`accept`, `content-type`, `idempotency-key`, `x-command-sequence`, `x-filler-version`, `last-event-id`), parsed `body`, and `status`. It keeps the last 2000. Control GETs and the health check are not logged. |
| `DELETE /__fake/log` | Clears the log. |

### Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT`, `HOST` | `3100`, `0.0.0.0` | Listener. |
| `FAKE_TRACK_SECONDS` | `240` | Track length when the command has no `segue` (with a segue, `cueOut - cueIn`). `0` never ends. |
| `FAKE_REDACT_URLS` | `1` | Strip URL- and credential-shaped keys from SSE data, as Palazzo does. |
| `FAKE_CAPABILITIES` | `next.bumper` | The `capabilities` the state lists. |
| `FAKE_FILLER_CLEARS_SILENCE` | `1` | Start with fallback clears the silence flag. |
| `FAKE_BIND_FILLER_ON_PLAYBACK` | `0` | Palazzo's real behaviour: a song command binds the newest prepared filler (`boundBy: "fallback"`). See below. |
| `FAKE_ACCEPT_UNPREPARED_FILLER` | `0` | Accept Start with a version the fake never prepared, for example after the fake restarts while Alcantara still has the version saved. |
| `FAKE_LEVELS_INTERVAL_MS`, `FAKE_HEARTBEAT_MS`, `FAKE_AUDIBLE_RMS`, `FAKE_START_DELAY_MS`, `FAKE_INTRO_SECONDS`, `FAKE_INSTANT_SECONDS`, `FAKE_LOG_LIMIT` | `1000`, `10000`, `0.2`, `300`, `5`, `3`, `2000` | Timing and levels. |

## Faked and left out

The shapes follow Alcántara's consumer code (`backend/src/radio/palazzo-machine.client.ts`,
`palazzo-contract.ts`, `palazzo-program.client.ts`) and Palazzo's documented lifecycle.

Left out or simplified:
- **No real audio or media.** Songs, intros, instants and fillers are never
  fetched, and filler checksums are trusted.
- **Liquidsoap and Icecast are always healthy.** `availability` is
  `available`, there is no `telemetry.connected`/`disconnected`, and
  `preflight.*`, `playout.fallback` and `playout.request_failed` are never
  emitted. No `PUT/GET /playback/preflight` route.
- **The filler does not really play.** Palazzo plays its local playlist only
  when the live song queue runs dry. The fake shows a bound filler as audible
  output when no track plays, and, by default, Start clears the silence flag.
  Real Palazzo would not cure a song that plays but is silent this way: its
  queue is not dry.
- **Binding on playback is off by default.** Real Palazzo binds the newest
  prepared filler on a song command (`bindMissingFiller`), so
  `GET /automation` then reports `filler.ready: true`. The Radio desk disables
  **Start with fallback** when `filler.ready` is true, so with real Palazzo a
  prepared playlist can be bound before the operator presses Start. Set
  `FAKE_BIND_FILLER_ON_PLAYBACK=1` to see that.
- `audio.levels` is sent once a second. Palazzo sends them up to every 100 ms.
- **The program id is not checked.** Real Palazzo serves one program
  (`assertProgram`); the fake serves any valid program id.
- **No persistence, no `/metrics`, no `/proxy-audio`, no authentication.**

## A Liquidsoap-down walk (#734)

Alcántara drops an event stream that sends nothing for 30 s. With Palazzo answering but Liquidsoap down, that drop
must reconnect without ever freezing automation (only a hung Palazzo, which also fails the state poll, freezes it):

1. Enable radio and play a song, as above.
2. Mute the event stream:
   ```bash
   docker compose exec palazzo wget -qO- --header 'Content-Type: application/json' \
     --post-data '{"muted":true}' http://127.0.0.1:3100/__fake/programs/radio-demo/mute-events
   ```
3. About 30 s later the backend logs `Palazzo event stream for radio-demo sent nothing for 30 s; reconnecting`, and
   `GET /radio/radio-demo/palazzo-status` goes `connecting`, then `polling` or `connected`. It never reads
   `unavailable`, and the backend never logs `Freezing radio automation`. While muted, this repeats about every 31 s.
4. Unmute with `{"muted":false}`; the stream resumes and the drops stop.

To see a hung Palazzo instead (which does freeze, at about 40 s), run `docker compose pause palazzo`.

## Tests

`backend/test/fake-palazzo.test.mjs`, part of `pnpm --dir backend run test:deployment`, has two parts:
- **The fake itself:** it starts the fake on a free local port and checks the recovery path (prepare, read back,
  bind on start, clear on stop), a malformed preparation, and `mute-events` (a silent stream that still gets its
  snapshot, a state that reports Liquidsoap down, and the stream resuming on unmute).
- **The shipping guard:** it checks that the fake is behind its profile in `compose.yml` and named nowhere that
  ships.
