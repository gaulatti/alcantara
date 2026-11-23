# Deploy candidate check

A new backend image is started once as a throwaway **candidate** and must answer before the running backend is stopped (gaulatti/alcantara#223). An image that cannot start no longer costs API downtime: before this check, the Cumulus deploy stopped the running container first, so a broken image took the API down for about two minutes until the rollback (2026-11-19, 04:02 to 04:04 UTC).

## What the deploy does (`deploy/cumulus.sh`)

After the restore check, the runtime preflight and the migrations, and before `docker stop alcantara-backend`:

1. Start `alcantara-backend-candidate` from the new image. It gets the same configuration and secrets as the live container, plus `ALCANTARA_DEPLOY_CANDIDATE=1`. It is not on the `broadcast-control` network, so it cannot reach Palazzo. It publishes no port, has no restart policy and gets no metrics token mount (its health check calls `GET /`, never `/metrics`; the token is provisioned after the candidate passes, see [radio-telemetry.md](radio-telemetry.md#metrics)).
2. Check `GET /` from inside the container, up to 45 tries 2 s apart. The check stops early if the container exits.
3. **Failure:** the deploy prints `Alcantara candidate failed its health check; the running backend is untouched` and the candidate's bounded log tail (on stderr, filtered as for the live container), removes the candidate and exits 1. The running backend is never stopped.
4. **Success:** the deploy removes the candidate, prints `Alcantara candidate passed its health check`, and replaces the running container exactly as before (with its own health check, rollback and `ALCANTARA_HEALTHY`).

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

## Proof

- `backend/test/deploy-candidate.e2e-spec.ts` runs against real PostgreSQL with the migrations applied. It seeds a running scheduled block and a due published block, then boots the full `AppModule` as a candidate. It checks that `GET /` answers, that a model write and a raw `UPDATE` are both refused with "read-only transaction", and that after 3.5 s (the rundown poll fires every second) both blocks and the program-state count are unchanged. It also seeds an enabled radio program mid-song (autoplay, a song on air, an active queue entry, a filler set): the engine loads it, the candidate still answers, and the program, its radio settings and the as-run log are unchanged. With the setting removed, the same test fails: a normal boot resets the running block and starts the due one.
- `backend/src/config/deploy-candidate.spec.ts` covers the setting's values, the read-only connection options, and each skipped hook, with the clock run two hours ahead.
- `backend/test/deployment-gate.test.js` runs `deploy/cumulus.sh` against stub commands. With an unhealthy candidate it exits 1 and never runs `docker stop`, `rename` or `start`, nor creates the live container. With a healthy one, it removes the candidate before stopping the live container and still ends with `ALCANTARA_HEALTHY`. The radio check's cases run there too (playing, not playing without rollback, skipped, unreadable), and its Palazzo poll runs for real against a local fake state endpoint: a song started after the restart passes, an idle or unreachable Palazzo fails with a report that carries no URL, and a song already on air extends the wait.

Adding a new start-up writer, claimer or timer means adding its candidate check, a row to the table above, and a case to `deploy-candidate.spec.ts`.
