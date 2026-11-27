# Deploy candidate check

A new backend image is started once as a throwaway **candidate** and must answer before the running backend is stopped (gaulatti/alcantara#223). An image that cannot start no longer costs API downtime: before this check, the Cumulus deploy stopped the running container first, so a broken image took the API down for about two minutes until the rollback (2026-11-19, 04:02 to 04:04 UTC).

## Start-up after the swap

The port opens once every start-up hook has returned, and the API is down until then. The media asset reconciliation and team fill therefore run in the background after start-up (gaulatti/alcantara#873): the API serves while they run, a failure is logged and counted as `media-asset-reconciliation` `failure` without stopping the backend, and a row saved while the pass reads it makes the pass run again (three attempts), so the pass never overwrites that save. The rotation engine starts where it did before. The similarity index load, the media analysis tool check and scheduling, and the first read of the team gauges do not hold the port either; the engine already waits for the similarity index before it picks from it.

## Migrations and nginx

The migrations run once, as their own step before the running backend is touched; the live container then starts the server only (`node dist/src/main`, under Docker's `--init` so that a stop is immediate), so a deploy does not migrate twice (gaulatti/alcantara#873). A container restart does not migrate either. Elsewhere the image's default command still migrates at start.

The installed nginx site is written, and `certbot --nginx` run, only while the host has no certificate or the installed site does not use one. A site that serves TLS is never overwritten (`NGINX_SITE_KEPT`), so a change to `deploy/cumulus.nginx.conf` is **not** applied by a deploy: the deploy prints `NGINX_SITE_DRIFT: ...` for each setting the installed site lacks, and it has to be added on the host.

A migration runs while the previous release still serves, so it must work with that release: add first, and drop or tighten in a later release. `backend/src/config/migration-safety.spec.ts` (part of the unit tests, so it gates Backend Deploy) fails on a new migration that drops a table, column or type, renames, makes a column required, changes a column type, or adds a required column with no default, unless the file says why that is safe on a line `-- reviewed-breaking: <reason>`. Create large indexes concurrently; the check does not see lock time.

## What the deploy does (`deploy/cumulus.sh`)

After the restore check, the runtime preflight and the migrations, and before `docker stop alcantara-backend`:

1. Start `alcantara-backend-candidate` from the new image. It gets the same configuration and secrets as the live container, plus `ALCANTARA_DEPLOY_CANDIDATE=1`. It is not on the `broadcast-control` network, so it cannot reach Palazzo. It publishes no port, has no restart policy and gets no metrics token mount (its health check calls `GET /`, never `/metrics`; the token is provisioned after the candidate passes, see [radio-telemetry.md](radio-telemetry.md#metrics)).
2. Check `GET /` from inside the container, up to 45 tries 2 s apart. The check stops early if the container exits.
3. **Failure:** the deploy prints `Alcantara candidate failed its health check; the running backend is untouched` and the candidate's bounded log tail (on stderr, filtered as for the live container), removes the candidate and exits 1. The running backend is never stopped.
4. **Success:** the deploy removes the candidate and prints `Alcantara candidate passed its health check`. Before removing it, it asks the candidate for `GET /health/ready`. A 200 means the image holds the playout lease (see below) and the deploy hands over without a gap (4a). Otherwise (an image from before the lease, 404), or when no backend is running, it replaces the running container exactly as before, with its own health check, rollback and `ALCANTARA_HEALTHY`.

4a. **The handover** (gaulatti/alcantara#873). Every live container runs `node dist/src/main` under Docker's init (`--init`).

   **When it runs.** All of these must hold, or the deploy prints `HANDOVER_SKIPPED: …` and replaces the container exactly as before:
   - the new image answers `/health/ready` (asked of its candidate);
   - the **running** backend reports `active` on its own port (a running backend from before the lease holds no lock, so a standby beside it would take the free lock and two engines would drive playout);
   - the host has at least 600 MB available (`MemAvailable`) for a second backend for about a minute.

   Today's path always serves on 3006, and nginx is pointed back at 3006 after it, whatever port a handover left.

   **Steps.**
   - It starts `alcantara-backend-next` beside the running one, on the other loopback port (3006 or 3007), and waits up to 90 s for `standby`. Seeing `active` while the old one is up removes it at once.
   - It points nginx at the new port (`BACKEND_SWITCH`). Only the installed site's `proxy_pass` port changes; certbot's TLS half stays. The new site is written beside the old one, checked non-empty and containing the new `proxy_pass`, then moved into place in one step. A full disk, a refused `nginx -t` or a failed reload leaves or puts back the previous site and reloads it, and the running backend stays untouched.
   - It waits until nginx's workers from before the reload stop accepting (`NGINX_SETTLED`, at most 5 s, then `NGINX_SETTLE_TIMEOUT`; without `pgrep`, a fixed 1 s). `systemctl reload` returns before they stop, and a new request one of them took would reach the old backend, which answers 503 once it starts closing. A worker kept by a long-lived stream stops accepting at once, so it does not hold this up.
   - It stops the old one (`docker stop -t 15`, `OWNER_RELEASED`) in the background and polls the new one's `/health/ready` every 0.2 s meanwhile, so `OWNER_ACQUIRED` says when the new one went `active` even while the old process is still exiting. It waits for the stop to finish before going on; if the new one was not active by then, it waits up to 20 s more. A stop that fails, and any other exit in between (an error, a signal), runs the restore below first.
   - After `OWNER_ACQUIRED` it prints both sides' own times: `OWNER_GRANTED` (when the new backend took the lock, from its `/health/ready`), then, from the stopped backend's log, `PREVIOUS_SIGTERM`, `PREVIOUS_STOPPING` (its writers began stopping) and `OWNER_UNLOCKED` (it freed the lock).
   - It then removes the stopped container (fix forward: no rollback container is left to stop later deploys) and renames the new one `alcantara-backend`. The public check and the radio check (5) follow, reading the live port from the container.

   **If the new one never takes the lease.** It is removed, nginx goes back, and the previous backend is started and must report `active` within 20 s (`OWNER_RESTORED`; otherwise `OWNER_NOT_RESTORED`, loudly, exit 1). The public and radio checks still run against the restored backend, and the deploy ends with `ALCANTARA_DEPLOY_FAILED`. That failure leaves no backend driving playout for up to 15 s (stop) + 20 s (wait) + the previous backend's boot to `active` (about 10 s since stage 0; bounded at 20 s), so 35–55 s. That is the same order as every deploy before #873 (46.6 s measured), and it happens only on this failure. Palazzo keeps playing throughout, and its filler covers air.

   The time with no backend driving playout on a normal handover is `OWNER_GRANTED − OWNER_UNLOCKED`. `OWNER_ACQUIRED − OWNER_RELEASED` bounds it from above: it also counts the old backend's shutdown up to the unlock, and the script's 0.5 s poll.

5. **The radio plays** (gaulatti/alcantara#230). A healthy backend is not a playing radio, so after `ALCANTARA_HEALTHY` the deploy reads `alcantara_radio_automatic_programs` from the new backend (inside its container, with its own mounted scrape token; the token never reaches the host shell).
   - `0`: it prints `RADIO_CHECK_SKIPPED: no radio program is in automation` and ends.
   - Unreadable: `RADIO_CHECK_FAILED: the backend did not report its automatic programs`, exit 1.
   - A live show on the air (`live.onAir`, gaulatti/palazzo#48) passes at once with `RADIO_LIVE`: a live show never fails a deploy.
   - Otherwise it polls Palazzo's own playback state every 5 s from inside the `palazzo` container until a song whose `track.startedAt` is at or after the moment just before the new backend started is playing, and prints `RADIO_PLAYING startedAt=…`. The bound is 120 s; a song already on air at the restart extends it to that song's remaining time plus 120 s, at most 15 minutes after the restart.
   - Past the bound it prints `RADIO_NOT_PLAYING {…}` (availability, status, track start, remaining time, intro, output level, live input, Liquidsoap and Icecast; no URLs) and `RADIO_CHECK_FAILED: no song started after the restart; the backend stays deployed`, and exits 1. It never rolls back: the new backend is healthy, and another restart is what turned one stall into three on 2026-11-20.

The on-premises path inside `.github/workflows/backend-deploy.yml` (used only when `ON_PREMISES` is `true`) does not have this step yet.

## Candidate mode (`ALCANTARA_DEPLOY_CANDIDATE`)

It is a start-up mode for that one throwaway container, not a feature flag. The normal container never has it. Unset means a normal instance, `1` means a candidate, and any other value fails start-up.

A candidate boots the whole HTTP application: it loads the secrets, connects to the database, verifies Pompeii, and loads the song engine's state (read only). It writes, claims and schedules nothing:

| Start-up or timer work | File | In a candidate |
|---|---|---|
| Every database session | `src/prisma-adapter.ts` | Opened with `default_transaction_read_only=on`, so PostgreSQL refuses any write, raw SQL included |
| Rundown reset of running scheduled blocks, and the one-second poll that claims and starts due published blocks | `src/program/flight.service.ts` (`onModuleInit`) | Skipped |
| Default program state upsert | `src/program/program.service.ts` (`onModuleInit`) | Skipped; engine event handlers still attach in memory |
| Palazzo telemetry supervisor (snapshots that drive playback) | `src/radio/palazzo-telemetry.service.ts` | Not started |
| Media asset reconciliation (deletes orphaned registry rows) | `src/media-assets/media-assets-reconciliation.service.ts` | Skipped |
| Media analysis queue | `src/media-analysis/media-analysis.service.ts` | Not scheduled |
| Hourly PostgreSQL backup | `src/database-backup/database-backup.service.ts` | Configuration validated, not scheduled |
| External chart poll | `src/charts/charts.service.ts` | Off |
| Similarity catalog refresh | `src/radio/song-similarity.service.ts` | Settings loaded once (read), no refresh |

Start-up hooks and timers left running, because none of them writes or claims:

| Hook | File | Why it is safe in a candidate |
|---|---|---|
| Song engine start-up | `src/radio/song-execution.engine.ts` (`onModuleInit`) | Reads enabled radio programs and their sequence, queue and rotation into memory; it waits for a Palazzo snapshot before playing, and with telemetry off that never comes. Proven with a mid-song program in the e2e. |
| Palazzo program client poll and reconnect | `src/radio/palazzo-program.client.ts` | Only started by the telemetry supervisor, which a candidate does not start. |
| Pompeii authorization check | `src/auth/pompeii.service.ts` (`onModuleInit`) | A read-only connection check; it fails start-up in production when Pompeii is unreachable, which is what a candidate should report. |
| MCP registry | `src/mcp/mcp-registry.service.ts` (`onModuleInit`) | Collects tool specs in memory. |
| MCP change feed | `src/mcp/tools/mcp-change.feed.ts` (`onModuleInit`) | Subscribes to program events in memory. |
| As-run subscription | `src/as-run/as-run.service.ts` (`onModuleInit`) | Writes only on engine track events, which need Palazzo; the database would refuse the write anyway. |
| Output-confidence timer | `src/radio/radio-output-confidence.service.ts` (`onModuleInit`) | Updates metrics in memory every 5 s. |

## Playout lease and standby (alcantara#873)

Exactly one backend instance drives playout. In production (`NODE_ENV=production`, not a candidate) an instance holds
a PostgreSQL advisory lock (`pg_try_advisory_lock(873001)`) on a connection of its own, not a pooled Prisma one, and
PostgreSQL frees the lock if the process or that connection dies. Until it holds the lock the instance is a
**standby**: it boots, listens and answers `GET /`, `/health/*` and `/metrics`, and holds every other request,
including WebSocket upgrades, until it becomes **active**. A held request waits at most 20 s, and at most 200 are held
at once; past either it gets `503` with `Retry-After: 2`. An instance that is shutting down never holds: from SIGTERM on, a held
request and any new one get that `503` at once, so a straggler cannot keep the old backend's HTTP server from closing,
and its retry reaches the instance that took over. The console's backend fetch sends a `503` that carries
`Retry-After` again quietly, after the wait it asks for (at most 5 s), for up to 6 s, so no caller sees it (a streamed
request body is sent once). The console's event streams reconnect on their own; they end at every shutdown anyway. The standby asks for the lock every 200 ms, so it takes a
freed lock within 0.2 s.

On taking the lock, the instance runs every writer and scheduler, in the order they registered, and only then reports
active and releases the held requests. The writers and schedulers are:

- the rotation engine's takeover (hydrate, recall the playing song, watchdog);
- Palazzo telemetry;
- the default program state;
- the rundown;
- the chart poll, the hourly backup, media analysis, the team gauge and media reconciliation;
- the scope preflight, the similarity refresh and the WebRTC sweeps.

`src/invariants/playout-singletons.spec.ts` fails when a provider starts a repeating timer outside `startWhenActive`
without a stated reason, so this list cannot drift.

While active, the lock connection is probed every 2 s. If it errors, ends or stops answering, the process exits with
code 1 (`alcantara_playout_lease_lost_total`): an instance that may have lost the lock must not command Palazzo. Docker
restarts it as a standby. If the database is away, nobody holds the lock and the radio stops advancing (Palazzo's filler
covers air) until it returns. That is deliberate: two engines would double-command Palazzo.

Locally, in CI and in tests (not `NODE_ENV=production`) the instance is active from the start: a single instance
behaves exactly as before the lease. A deploy candidate is a permanent standby that never asks for the lock, and it
does not hold requests (it serves read-only, as above).

`GET /health/ready` answers `{"state":"standby"|"active","build":"<sha>","grantedAt":<iso>|null,"activeSince":<iso>|null}`:
when this instance took the lock, and when it then reported active. The backend also logs the handover to the
millisecond (the logger's own stamp is to the second): `PLAYOUT_SIGTERM`, `PLAYOUT_STOPPING` and `PLAYOUT_UNLOCKED` on the
instance that lets go, and `PLAYOUT_GRANTED` and `PLAYOUT_ACTIVE` (with the activation time) on the one that takes over. An image without it answers 404, which
the deploy reads as "no lease".

On SIGTERM (`enableShutdownHooks()`, with Node exec'd as the container's main process) the instance shuts down in this
order:

1. **Stop** (every module's `onModuleDestroy`): it ends its program streams and WebSocket clients (they reconnect and
   resync) and stops the engine and every scheduler. The lease stops asking for the lock here but keeps it. The engine
   and the schedulers live in global modules beside the lease, so Nest's module order alone would not put them first.
2. **Release** (`beforeApplicationShutdown`, after every stop above has finished): the instance reports `standby`,
   sends `pg_advisory_unlock(873001)` (waiting at most 2 s), and closes the lock connection. Closing the connection
   frees the lock even if the unlock did not answer.
3. **Close**: the HTTP server closes and the process exits.

From the release on, the engine sends Palazzo nothing: before each song, announcement, withdrawal or spot it checks
that the instance still holds the lease, so a command already in flight when the lock went is dropped. A standby that
takes the lock while shutting down gives it straight back and starts nothing.
`src/playout/playout-lease.shutdown.spec.ts` closes a Nest application with an engine module registered before and
after the lease, and checks the order: engine stopped, unlock, connection closed.

Metrics:

- `alcantara_playout_lease{state}` (1 for the current state);
- `alcantara_playout_activation_seconds`;
- `alcantara_playout_lease_lost_total`;
- `alcantara_playout_held_requests_total{result="served|timeout|rejected"}`;
- `alcantara_playout_hold_seconds`.

## Proof

- `backend/test/deploy-candidate.e2e-spec.ts` runs against real PostgreSQL with the migrations applied. It seeds a running scheduled block and a due published block, then boots the full `AppModule` as a candidate. It checks that `GET /` answers, that a model write and a raw `UPDATE` are both refused with "read-only transaction", and that after 3.5 s (the rundown poll fires every second) both blocks and the program-state count are unchanged. It also seeds an enabled radio program mid-song (autoplay, a song on air, an active queue entry, a filler set): the engine loads it, the candidate still answers, and the program, its radio settings and the as-run log are unchanged. With the setting removed, the same test fails: a normal boot resets the running block and starts the due one.
- `backend/src/config/deploy-candidate.spec.ts` covers the setting's values, the read-only connection options, and each skipped hook, with the clock run two hours ahead.
- `backend/test/deployment-gate.test.js` runs `deploy/cumulus.sh` against stub commands. With an unhealthy candidate it exits 1 and never runs `docker stop`, `rename` or `start`, nor creates the live container. With a healthy one, it removes the candidate before stopping the live container and still ends with `ALCANTARA_HEALTHY`. The radio check's cases run there too (playing, not playing without rollback, skipped, unreadable), and its Palazzo poll runs for real against a local fake state endpoint: a song started after the restart passes, an idle or unreachable Palazzo fails with a report that carries no URL, and a song already on air extends the wait.

Adding a new start-up writer, claimer or timer means adding its candidate check, a row to the table above, and a case to `deploy-candidate.spec.ts`.
