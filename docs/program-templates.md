# Program template contracts

Alcantara owns program state and control. It does not own the Fifthbell visual
template. Brokaw builds the renderer and its machine-readable contract;
Cronkite validates that package and publishes an immutable release to the CDN.
Alcantara registers the release manifest against a program and opens the
manifest's entrypoint with its declared runtime query parameters.

## Published contract

The initial contract is `kind: alcantara.program-template`,
`contractVersion: 1`, and state `schemaVersion: 1`. A manifest declares:

- template identity, package, bundle version, and relative HTML entrypoint;
- bounded capabilities such as `audio.playback`, `media.groups`,
  `scene.configuration`, and `stinger.transitions`;
- the `alcantara.program.v1` control protocol over server-sent events;
- relative snapshot and event paths;
- query-parameter names for `programId` and `apiBaseUrl`;
- the exact signal types accepted by the renderer; and
- release files, content types, byte counts, and SHA-256 digests.

For Brokaw `0.1.65`, Cronkite publishes the immutable registration URL at:

```text
https://cdn.fifthbell.com/html/program-releases/0.1.65/live-program-manifest.json
```

The manifest entrypoint resolves within that same release prefix. The rendered
page runs on `https://cdn.fifthbell.com`, so Alcantara's API permits that exact
browser origin. `https://fifthbell.com` is also allowed for a later public-route
alias; wildcard origins are not used.

## Register a program

Open **Programs**, create or edit a program, paste the immutable JSON manifest
URL into **Template URL**, and choose **Inspect**. Alcantara fetches the URL on
the server, verifies the contract, and displays its capabilities. Saving repeats
the inspection so a stale preview cannot bypass validation. Program list cards
and the global **Open Program Output** action then open the external entrypoint
with the selected program ID and the configured Alcantara API origin.

The production registration endpoint accepts only HTTPS manifests from the
code-owned Cronkite publisher origin `https://cdn.fifthbell.com`. Local
development additionally permits `http://localhost` and `http://127.0.0.1`.
Manifest requests reject credentials, query strings, fragments, unsafe
relative paths, non-JSON responses, bodies larger than 256 KiB, more than three
redirects, and hosts resolving to private, loopback, link-local, multicast, or
documentation networks. Each redirect is checked again.

Registration stores the final manifest URL, the normalized contract, its
same-origin entrypoint URL, and the verification time. It does not load or
execute template JavaScript inside the Alcantara application.

## Public state and signals

For a registered program, `GET /program/:programId/state` returns only schema
version, program identity, active/staged scene projections, fade-to-black state,
timestamps, and version. It omits operator queues, assignments, stored template
metadata, and unrelated persistence fields.

`GET /program/:programId/events` begins with the bounded snapshot, forwards only
signal types declared by the stored manifest, projects each signal to its
renderer fields, and emits a 15-second heartbeat when declared. Existing
unregistered programs keep the legacy response during migration so the current
renderer remains a rollback path.

The private authenticated `/metrics` collector includes:

- `alcantara_dependency_operations_total{dependency="program-template",operation="fetch",result}`;
- `alcantara_dependency_duration_seconds{dependency="program-template",operation="fetch"}`;
- `alcantara_program_sse_connections`; and
- `alcantara_program_sse_snapshots_total{result}`.

Template URLs and identities never appear in metric labels. A successful
inspection records `success`; any rejected or failed inspection records the
bounded `failure` result. HTTP route metrics continue to cover response status
and latency for registration and public state/SSE requests.

## Release and cutover

Release in dependency order:

1. Publish the tagged Brokaw package.
2. Configure Cronkite with that exact package version and let startup publish
   the immutable release before its canonical HTML pointer.
3. Deploy the Alcantara schema migration and application.
4. Register the Fifthbell program with the immutable manifest URL.
5. Verify the CDN manifest and entrypoint, browser CORS, initial state, live SSE
   scene changes, audio control, and reconnect heartbeat.
6. Remove `frontend/app/programs/fifthbell/**`,
   `frontend/public/fifthbell/**`, and the legacy Alcantara output route only
   after the external renderer has passed those production checks.

Rollback is data-only until step 6: clear the program's Template URL to return
to the legacy Alcantara renderer. After step 6, roll back by redeploying the
last frontend version containing that route or register a previously verified
immutable Brokaw release. Never overwrite an immutable release prefix.
