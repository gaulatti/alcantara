# Versioned broadcast destinations

Alcantara owns the operator-visible catalog and the decision about which public
destinations receive each television broadcast. It stores opaque IDs, display
metadata, and exact AWS Secrets Manager references. It never requests or stores
the stream key or publish URL held by those references.

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
fictional values and requires no AWS access.

The private metrics endpoint exposes:

- `alcantara_dependency_operations_total{dependency="alana",operation=...}`
  and `alcantara_dependency_duration_seconds` for bounded `status`, `reload`,
  `start`, and `stop` dependency operations.
- `alcantara_broadcast_destination_operations_total{action,result}` for bounded
  reload/Start/Stop outcomes.

Exact destination IDs, selection versions, hashes, references, program IDs, and
error bodies are deliberately absent from metric labels.
