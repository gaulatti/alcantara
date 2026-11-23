# Versioned broadcast destinations

Alcantara owns the operator-visible catalog and the decision about which public
destinations receive each television broadcast. It stores opaque IDs, display
metadata, and exact AWS Secrets Manager references. It does not store the stream
key or publish URL held by those references, and the television playout path
(Alana, Croccante) never receives them from Alcantara. The one exception is the
operator-facing ingest route below, which reads a key for the desktop studio and
returns it to a signed-in operator without keeping it.

## Ownership and command flow

1. A user with `broadcast.manage` creates, edits, retires, restores, or reorders
   catalog entries. A catalog update changes only future immutable selections.
2. A user with `broadcast.operate` selects 1-20 current destinations and
   deliberately confirms Start. Alcantara snapshots the display metadata and
   exact secret references into a new immutable selection version and audit
   command.
3. While Alana is stopped, Alcantara sends that exact selection to Alana's
   authenticated destination-reload endpoint. Alcantara then sends Start to
   Alana with the same version, opaque IDs, and references.
4. Alana prepares its television pipeline and forwards the selection to
   Croccante. Croccante alone resolves the references and supervises the public
   relay processes.
5. Alcantara reports Running only when Alana returns Running and acknowledges
   the exact selection version, SHA-256 hash, count, and ordered opaque IDs.

Alcantara never calls Croccante. A `both` program sends destination selection
only through the Alana television leg; this feature does not issue or change a
radio command.

## Permissions and redaction

The backend independently enforces the three Pompeii-owned decisions:

- `broadcast.view` reads bounded lifecycle, readiness, and relay state plus the
  safe catalog fields: opaque ID, display name, order, and retirement state.
- `broadcast.operate` reloads a stopped selection and issues confirmed
  destination-carrying Start/Stop commands.
- `broadcast.manage` reads and changes the Secrets Manager references in the
  catalog. This grant does not imply permission to operate a broadcast.

Only the management endpoint returns secret identifiers and pinned version
IDs. View and operation responses, downstream state, logs, and Prometheus
labels omit references, URLs, stream keys, provider payloads, and user IDs.

## Adding a destination by service and key

An operator with `broadcast.manage` adds a destination by choosing a service, giving a
name and entering the stream key; they never type a Secrets Manager name or version
(gaulatti/alcantara#376).

- `POST /broadcast/destinations` with `{service: "youtube" | "custom", name, ingestUrl?, streamKey}`.
  YouTube's address is fixed (`rtmps://a.rtmps.youtube.com:443/live2`); a custom service
  needs an `rtmp://` or `rtmps://` address with a host and an application path. The name is
  unique within the team (case-insensitive); the id is its slug, made unique with a numeric
  suffix. The backend creates one secret per destination named
  `alcantara/destinations/<team>/<id>` holding the payload the ingest route and Croccante
  read, pins the version Secrets Manager returns, stamps the caller's team and records who
  added it. If the row cannot be saved the secret it just created is deleted.
- `PUT /broadcast/destinations/:destinationId/key` with `{streamKey}` writes a new version of
  that secret and re-pins it; a destination whose reference was typed by hand names its
  `service` (and `ingestUrl`) once, and its key moves under a secret this backend owns. The
  pinned version means a failed write leaves the running destinations untouched.
- `PUT /broadcast/destinations/:destinationId` renames (`{displayName}`); the secret and key
  are not touched.
- The catalog (`GET /broadcast/destinations/catalog`) adds `service`, `ingestUrl`, `keyLast4`
  (the last four characters of a key of 8 or more, never more) and `keySetAt`. The key is
  shown nowhere after it is saved except by the ingest route. None of these routes is an MCP
  capability (they carry a credential); MCP can rename, retire, restore, reorder and read.
- Audit: a `BroadcastDestinationKeyChange` row (team, destination, subject, `created` or
  `replaced`, time) is written in the same transaction as the change; never the key.
  Metrics: `alcantara_broadcast_destination_operations_total{action="create"|"replace_key"}`.
- IAM: the backend role needs `secretsmanager:CreateSecret`, `PutSecretValue`, `GetSecretValue`
  and `DeleteSecret` on `arn:aws:secretsmanager:*:*:secret:alcantara/destinations/*` only.
  Retiring a destination does not delete its secret (a retired destination can be restored).

## Ingest credential for the desktop studio

The desktop studio publishes straight from the operator's Mac and needs one
destination's ingest address and key at Go live (gaulatti/carmencita#4).

`POST /broadcast/destinations/{destinationId}/ingest` (no body) requires
`broadcast.manage`, the same grant that already reads the catalog's Secrets
Manager references. It reads the exact secret version the catalog pins and
answers `200` with `Cache-Control: no-store`:

```json
{ "destinationId": "youtube", "displayName": "YouTube", "ingestUrl": "rtmps://a.rtmps.youtube.com:443/live2", "streamKey": "..." }
```

`ingestUrl` is `scheme://host[:port]/application`, never the key. The secret
payload has the same shape Croccante reads (`scheme`, `host`, optional `port`,
`application`, `streamKey`); anything else is refused.

| Status | Meaning |
|---|---|
| 400 | malformed destination ID |
| 401 | no valid session |
| 403 | signed in without `broadcast.manage` |
| 404 | unknown destination |
| 409 | the destination is retired |
| 503 | the secret could not be read or was invalid, or the audit row could not be written; nothing is returned |

Every call writes a `BroadcastIngestAccess` row (subject, destination ID,
time, and a bounded outcome: `issued`, `not_found`, `retired` or
`unavailable`) before anything is returned, so a failed audit write returns no
key. The key is never stored, logged, put in an error, a metric label or the
audit row. The route is not an MCP capability (Appendix A lists it as
excluded because it returns a credential). `alcantara_broadcast_destination_operations_total`
counts it as `action="ingest"` with `result` `succeeded` or `failed`.

The list of destinations without keys is the existing
`GET /broadcast/destinations` (`broadcast.view`). It lists only the caller's team's
destinations (every destination where no team is configured, which production
refuses), so it never offers one the ingest route would answer 404 for. A
destination with no team is not listed until its `teamId` is stamped. A destination created by a
caller with a team (HTTP or MCP) is stamped with that team; with no team
configured it is not stamped.

## Immutability and idempotency

Catalog entries are mutable planning records. Every reload or Start instead
uses an immutable database snapshot containing its own display metadata and
exact reference versions. Editing or retiring a catalog entry therefore cannot
change a running session. Retired entries are rejected from every later Start,
including an attempted replay of an older selection version.

Every command has a stable operator-supplied command ID and a canonical request
hash. Replaying the same ID and semantic request returns the recorded result or
retries the same downstream command. Reusing an ID for a different action,
selection, or program returns `409`. Alcantara allocates a program-scoped
sequence above both its local next value and Alana's last accepted sequence.

## State and recovery

`GET /broadcast/programs/{programId}` reconciles Alana before returning state.
Unreachable or invalid downstream state is explicit `available: false`; it is
never converted into Stopped. Partial or mismatched destination acknowledgement
is degraded/failure and never Running.

An explicit destination reload is allowed only when Alana reports requested and
actual Stopped with no transition. An active broadcast must be explicitly
Stopped before a changed selection can be reloaded. After an Alcantara restart,
the next read reconciles Alana and the next command advances beyond Alana's
persisted sequence. Executors continue in their last commanded state while
Alcantara is unavailable.

Recovery order:

1. Restore Alana reachability and inspect requested/actual state.
2. If Running or Degraded, do not edit the active selection; confirm Stop and
   wait for an exact Stopped acknowledgement.
3. Select current catalog entries and use **Reload while stopped** to validate
   the next immutable version.
4. Confirm Start. Investigate Alana/Croccante if the selection hash, count, or
   destination IDs do not match; do not bypass Alana.

## Configuration and observability

Production loads `alanaControlUrl` and `alanaControlToken` from the allowlisted
Alcantara Secrets Manager payload. During the documented file-mount migration,
`ALANA_CONTROL_TOKEN_FILE` and the non-secret `ALANA_CONTROL_URL` may be used
alongside the Palazzo executor token file. Local Compose supplies explicit
fictional values and routes the `main` program through the shared private Alana
recording-and-destination fixture, requiring no AWS access.

The private metrics endpoint exposes:

- `alcantara_dependency_operations_total{dependency="alana",operation=...}`
  and `alcantara_dependency_duration_seconds` for bounded `status`, `reload`,
  `start`, `stop`, and (for program fillers) `profile` and `prepare`
  dependency operations.
- `alcantara_broadcast_destination_operations_total{action,result}` for bounded
  reload/Start/Stop outcomes.

Exact destination IDs, selection versions, hashes, references, program IDs, and
error bodies are deliberately absent from metric labels.

Start also binds the program television filler when one is configured; see
[`program-filler.md`](program-filler.md).
