# Program recording control

Alcantara is the authenticated operator control plane for Alana's composed
Program recording. It does not capture, store, verify, serve, or delete media.
The consumed contract is the Alana recorder landed by
[`gaulatti/alana#16`](https://github.com/gaulatti/alana/pull/16), merge commit
`fcc1ec29a4239631d7fb146b2d9ea905103aa0f2`.

## Truthful state

The control panel shows only the bounded state returned by Alana:

- `disabled`: the Alana runtime has no recording control.
- `idle`: recording is enabled and no operation is active.
- `requested`: Start was accepted but capture is not yet confirmed.
- `active`: Alana confirmed capture. This is the only state that displays
  `REC`.
- `finalizing`: capture stopped, but the manifest and final artifact are not
  yet verified. Media is not safe to claim or publish.
- `complete`: Alana verified the manifest and final artifact.
- `failed`: recording failed. Alcantara keeps the independent broadcast
  controls usable and reports only Alana's bounded failure reason; it does not
  claim that a broadcast was live.

Duration, bytes, segment count, restart count, finalization state, and the disk
reserve are Alana-owned observations. Alcantara does not infer them or construct
paths to an artifact. A disk warning appears when remaining space approaches
Alana's configured reserve or retained bytes approach its quota.

## API and authorization

Alcantara exposes these authenticated routes:

| Method | Route                                  | Permission                  | Behavior                                     |
| ------ | -------------------------------------- | --------------------------- | -------------------------------------------- |
| `GET`  | `/program/{programId}/recording`       | `alcantara:program:read`    | Reconcile current Alana state                |
| `POST` | `/program/{programId}/recording/start` | `alcantara:program:operate` | Request independent capture                  |
| `POST` | `/program/{programId}/recording/stop`  | `alcantara:program:operate` | Stop capture and begin verified finalization |

Start and Stop require a bounded `Idempotency-Key`. Alcantara passes that exact
key to Alana and sends no command body. The browser disables a command while it
is in flight and retains the key after an ambiguous server failure so an
operator retry cannot repeat the side effect. Alana remains the durable
idempotency authority.

Stop requires an explicit browser confirmation. The landed Alana API has no
discard command, so Alcantara does not invent one. Artifact retention or
operator cleanup remains an Alana storage operation after capture is inactive;
it must not be represented as a recording Stop.

The browser reconciles on initial load, every 2.5 seconds, window focus,
visibility return, and network return. Browser state is never authoritative
after a reload or reconnect.

## Private service configuration

`ALANA_CONTROL_URL` must be a private HTTP(S) origin without credentials, path,
query, or fragment. `ALANA_CONTROL_TOKEN` is backend-only. Production loads the
allowlisted `alanaControlUrl` and `alanaControlToken` scalars from the same
application-scoped Secrets Manager payload as the Palazzo values before Nest
constructs the adapter. Missing, malformed, or unavailable configuration fails
the preflight without replacing the running backend.

During a bounded migration, production can instead supply both
`PALAZZO_CONTROL_TOKEN_FILE` and `ALANA_CONTROL_TOKEN_FILE`, plus their approved
service URLs. No token or Alana address is exposed to the frontend.

Local Compose starts a committed, private `alana-recording-fixture` service for
the fictional `modoitaliano` program. It implements the landed status,
Start/Stop, finalization, authorization, and idempotency shapes so the complete
browser-to-backend path is testable without AWS, production media, an Alana
checkout, or a real recorder. It never produces media and is not a deployment
substitute.

## Audit and metrics

Recording commands emit a structured log containing only the closed event,
action, result, and HTTP status. Program IDs, paths, tokens, artifact hashes,
provider bodies, and free-form errors are excluded.

The private authenticated Prometheus endpoint adds:

- `alcantara_recording_commands_total{action,result}` for bounded Start/Stop
  outcomes.
- `alcantara_recording_reconciliations_total{state,result}` for bounded Alana
  state reads.
- existing `alcantara_dependency_operations_total` and
  `alcantara_dependency_duration_seconds` with `dependency="alana"` and
  `operation="read"|"write"`.

These metrics show control-plane behavior only. Alana remains authoritative for
capture health, disk, segments, final artifact verification, and its recorder
metrics.

## Rollout and recovery

Before deployment, add the two Alana fields to the Alcantara production secret
and verify that the selected Alana runtime is on the shared private network and
has recording enabled. Exercise a bounded Start, observe `requested -> active`,
confirm Stop, observe `finalizing -> complete`, and verify the artifact directly
through Alana's documented operator boundary.

On an Alana outage or malformed response, Alcantara shows recording control as
unavailable and does not change the broadcast lifecycle. Recover Alana first;
the next scheduled or focus/reconnect reconciliation restores the authoritative
state. A `failed` recording must not stop, disable, or visually downgrade the
separate Program live controls.
