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

Production uses the code-owned Secrets Manager identifier
`broadcast/production/config`. The payload must contain all four exact private
service keys below. The loader ignores every other key rather than injecting it
into the process environment.

| Secret key            | Contract                                                                          | Owner                                                                         |
| --------------------- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `palazzoControlToken` | Existing opaque Palazzo bearer credential                                         | Palazzo operator                                                              |
| `palazzoAllowedUrls`  | Existing comma-separated origin allowlist                                         | Alcantara operator                                                            |
| `alanaControlToken`   | Exactly 64 lowercase hexadecimal characters (32 random bytes), with no whitespace | Alana operator generates; Alcantara secret owner installs the identical value |
| `alanaControlUrl`     | One private HTTP(S) origin                                                        | Alana operator supplies; Alcantara secret owner installs                      |

`alanaControlUrl` cannot contain credentials, a path, query, or fragment. Its
host must be a single-label service name, `localhost`, a `.localhost`, `.local`,
or `.internal` name, or a loopback/link-local/private IPv4 or IPv6 address.
Public IP addresses and public DNS names fail closed. The intended shared
Docker-network value is `http://alana:8080`; the production deployment ticket
must still prove private routing rather than treating syntax validation as a
network check.

The backend receives the token only as `ALANA_CONTROL_TOKEN`, after the startup
loader has selected and validated the secret. It is never a frontend variable,
Docker build argument, command-line value, metric label, or log field. Contract
and runtime preflight output names only the invalid field or a bounded failure;
it never echoes the secret document, URL, token, provider response, or
credential-bearing exception.

The deploy workflow streams the selected secret directly from Secrets Manager
into the zero-dependency contract validator before registry login, image build,
or push. The workflow role can read only this named secret. The validator does
not write a file or contact Alana. The target-host runtime preflight remains in
place before database migration or backend replacement so retrieval and image
startup fail closed at both boundaries.

During a bounded migration, production can instead supply both
`PALAZZO_CONTROL_TOKEN_FILE` and `ALANA_CONTROL_TOKEN_FILE`, plus their approved
service URLs. The Alana file must contain the same 64-character token, with an
optional final newline. No token or Alana address is exposed to the frontend.

Local Compose starts a committed, private `alana-recording-fixture` service for
the fictional `modoitaliano` program. It implements the landed status,
Start/Stop, finalization, authorization, and idempotency shapes so the complete
browser-to-backend path is testable without AWS, production media, an Alana
checkout, or a real recorder. Its injected clock and scheduler make requested,
active, finalizing, complete, duplicate, conflict, unauthorized, and not-active
results deterministic in tests. It never produces media and is not a deployment
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

Issue #61 does not create or rotate a credential. For an authorized installation
or rotation, use only protected files and placeholder variables; never place a
token in shell history, command arguments, GitHub evidence, or a repository:

```bash
SECRET_ID='<alcantara-runtime-secret-id>'
NEW_SECRET_DOCUMENT='<protected-path-to-complete-new-secret-json>'
NEW_ALANA_TOKEN_FILE='<protected-path-to-new-alana-token>'
ALANA_TOKEN_DESTINATION='<alana-host-token-path>'

node backend/src/config/runtime-secret-contract.js < "$NEW_SECRET_DOCUMENT"
aws secretsmanager put-secret-value \
  --secret-id "$SECRET_ID" \
  --secret-string "file://$NEW_SECRET_DOCUMENT"
install -m 0600 "$NEW_ALANA_TOKEN_FILE" "$ALANA_TOKEN_DESTINATION"
```

Alana accepts one token at a time, so first installation or rotation needs an
explicit bounded maintenance window for recording control. The Alana operator
owns token generation, the protected token file, and the Alana restart. The
Alcantara secret owner owns the matching `alanaControlToken` and
`alanaControlUrl` values. Record only the new and previous secret version IDs,
the image SHA, and timestamps. Restart Alana and then deploy/restart Alcantara;
do not enable recording until authenticated Status succeeds.

Keep the previous protected token file and secret version until the lifecycle
smoke passes. Placeholder-only rollback is:

```bash
SECRET_ID='<alcantara-runtime-secret-id>'
PREVIOUS_SECRET_VERSION_ID='<previous-version-id>'
FAILED_SECRET_VERSION_ID='<failed-version-id>'
PREVIOUS_ALANA_TOKEN_FILE='<protected-path-to-previous-alana-token>'
ALANA_TOKEN_DESTINATION='<alana-host-token-path>'

aws secretsmanager update-secret-version-stage \
  --secret-id "$SECRET_ID" \
  --version-stage AWSCURRENT \
  --move-to-version-id "$PREVIOUS_SECRET_VERSION_ID" \
  --remove-from-version-id "$FAILED_SECRET_VERSION_ID"
install -m 0600 "$PREVIOUS_ALANA_TOKEN_FILE" "$ALANA_TOKEN_DESTINATION"
```

Restart Alana and restore the previously recorded Alcantara image, then confirm
authenticated Status before reopening Start/Stop. Delete neither protected
token file nor secret version until rollback verification is complete.

Before deployment, install the two Alana fields in the production secret and
verify that the selected Alana runtime is on the shared private network and has
recording enabled. Exercise a bounded Start, observe `requested -> active`,
confirm Stop, observe `finalizing -> complete`, and verify the artifact directly
through Alana's documented operator boundary.

On an Alana outage or malformed response, Alcantara shows recording control as
unavailable and does not change the broadcast lifecycle. Recover Alana first;
the next scheduled or focus/reconnect reconciliation restores the authoritative
state. A `failed` recording must not stop, disable, or visually downgrade the
separate Program live controls.
