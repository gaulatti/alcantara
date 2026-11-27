# Production status check

`scripts/production-status.mjs` prints the state of production as one line per claim. Each line is `1` when the claim
holds, or `0` when it does not hold or could not be read. A claim that could not be read is never reported as holding.
It is read only, so it is safe to run at any time, for example for an hourly status page.

```sh
ALCANTARA_TOKEN_FILE=~/.alcantara-status-token node scripts/production-status.mjs
```

Each line reads `<1|0> <name> <ISO time of the read> <evidence>`. The exit code is 0 when every line is 1, 1 when any
line is 0, and 2 on a usage error (a bad `PROGRAM_ID` or `STATUS_DOCKER`, or a token file that cannot be read).

## What it reads, and nothing else

- **MCP read tools** at `ALCANTARA_API_URL/mcp`, as the token's owner: `get_on_air`, `get_radio_health`,
  `call_capability webrtc_health`, and the **dry run** of `webrtc_host_mic_off`. That action has no read of its own.
  The check sends `dry_run: true` and never a `confirm`, so the server refuses to run it (`confirm_required`). Each
  dry run is audited and counts toward the MCP rate limit, like any dry run.
- **Over SSH on cumulus** (`CUMULUS_SSH`), through one `sh -s` script sent on stdin:
  - Palazzo's own `GET /v1/programs/<id>/playback/state`, read inside the `palazzo` container. Only status,
    availability, Icecast and Liquidsoap connection, output RMS, sample time and `live.onAir` leave the host; no title
    or URL does.
  - Two gauges of the backend's private `/metrics`, read inside `alcantara-backend` as the deploy does: the scrape
    token stays in that process.
  - `docker inspect` of `alcantara-contribution`: its state, health, image and start time only, never its environment.
    The git blob id of its `/app/worker.mjs` is also read.
- **Over SSH on Helix** (`HELIX_SSH`): the same `docker inspect` and blob id for `alcantara-return-runner`
  (`/app/runner.mjs`).
- The public `GET /health/ready` (the backend's `build`, which is its commit) and the frontend's `index.html` (its
  manifest version).
- `git fetch origin main` in this checkout, and `gh run list` for the last green Frontend Deploy run.

It sends no tone, makes no invitation and writes nothing in production.

## The lines

| Line | 1 when | Source |
| --- | --- | --- |
| `radio_audible` | Palazzo is `playing` to a connected Icecast with output RMS above 0.001 (the backend's own audio threshold), and the backend counts no program silent. | Palazzo state, backend gauge |
| `next_song_accepted` | The song announced next has status `accepted` by Palazzo. | `get_on_air` |
| `palazzo_connected` | The backend's Palazzo connection is `connected` and not degraded. | `get_radio_health` |
| `calls_health` | `returnRunner`, `contribution` and `livekit` are each `ok`. The line's time is the check's `checkedAt`. | `webrtc_health` |
| `live_onair_false_without_guest` | Palazzo's live input is off air, or it is on air with a guest cued live or a host microphone published. An absent or stale `live` reading is 0: unknown is never off. | Palazzo state, backend gauge, host-mic dry run |
| `contribution_container`, `return_runner_container` | The container is running and `healthy`, and the file it runs is origin/main's. The evidence names the newest main commit with that exact file ("as of …"). | `docker inspect`, blob id |
| `backend_deployed` | `/health/ready`'s build is origin/main, or nothing the Backend Deploy watches changed since. The evidence adds the playout lease. | `/health/ready`, git |
| `frontend_deployed` | The last green Frontend Deploy commit is origin/main, or nothing under `frontend/` changed since. The served bundle carries no commit, so the evidence adds its manifest version. | `gh run list`, git, index page |
| `legacy_host_mic_absent` | No published host microphone uses an old `operator-*` identity. The fixed `operator-host-mic-<program>` identity does not count. This is a sample at the time of the read, and the #880 closer needs every hourly sample for 24 hours. | host-mic dry run |

## The token

Create a personal access token on the **Access** page ([Access](access.md)). Give it only `alcantara:radio:read`,
`alcantara:webrtc:read` and `alcantara:webrtc:operate`; the last one is what the `webrtc_host_mic_off` dry run is
checked against. Put the value in a file only you can read (`chmod 600`) and pass its path as `ALCANTARA_TOKEN_FILE`.
The value is never printed, logged or passed on a command line. Without `ALCANTARA_TOKEN_FILE`, the four MCP-read lines
print 0 with `not read: … (no ALCANTARA_TOKEN_FILE)`, and the other lines are still read.

## Settings

`ALCANTARA_API_URL` (https://api.alcantara.gaulatti.com), `ALCANTARA_APP_URL` (https://alcantara.gaulatti.com),
`PROGRAM_ID` (modoitaliano.fm), `CUMULUS_SSH` (cumulus.gaulatti.com), `HELIX_SSH` (helix.gaulatti.com),
`STATUS_DOCKER` (`docker`, or `sudo docker`), `GITHUB_REPO` (gaulatti/alcantara). SSH runs with `BatchMode=yes`, so a
host it cannot reach without a prompt gives 0 lines, never a hang.

## Tests

`scripts/production-status.test.mjs` runs in `pnpm --dir backend run test:deployment`. It covers:

- every line's 1, 0 and not-read cases;
- that an MCP body can never carry a `confirm`, and that the token goes only in the header;
- git's blob id;
- the host scripts run through `sh` against a stand-in `docker`.

## The older-console host-mic gate (#880)

`node scripts/host-mic-gate.mjs` reads log files already pulled and says whether 24 hours have passed with no host
microphone from an ordinary `operator-*` connection since 2026-11-27T12:29Z. Save the worker's lines before any
worker redeploy: a new container starts with an empty log.

```sh
ssh helix.gaulatti.com "sh -c 'docker logs alcantara-livekit 2>&1 | grep \"mediaTrack published\"'" > livekit.log
ssh helix.gaulatti.com "sh -c 'docker inspect -f {{.Created}} alcantara-livekit'"
ssh cumulus.gaulatti.com "sh -c 'docker logs --timestamps alcantara-contribution 2>&1 | grep \"track subscribed\" || true'" > worker.log
node scripts/host-mic-gate.mjs --livekit livekit.log --livekit-created <the inspect output> --worker worker.log
```

LiveKit does not log track names, so any audio an ordinary operator connection published counts, talkback included;
the printed sighting shows its time and identity.

