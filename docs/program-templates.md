# Program templates and renderers

Alcántara is the control plane. It owns program state, control and delivery of that state; it does not own how a
program looks.

## Where renderers live

Renderers belong to the brand libraries:

| Brand | Library |
| --- | --- |
| gaulatti | `@gaulatti/bleecker` |
| Fifth Bell | `@fifthbell/brokaw` |
| Modo Italiano | `@modoitaliano/giorgia` |

A renderer reaches air in one of two ways:

- **Placed by the program page.** `frontend/app/routes/program.tsx` places library components for a scene's component
  types and passes them the stored settings. The app holds adapters, not copies: a guard test
  (`frontend/app/scenes/noLocalRenderers.test.ts`) keeps each one a thin host over a library export.
- **Published as a template.** A library's release is published to a CDN with a manifest, and a program is registered
  against that manifest. The release's own page reads the program's public state and events.

A new visual piece is added to its library, released, and then consumed here by bumping the pinned version.

## Published contract

A manifest is `kind: alcantara.program-template` with `contractVersion` 1 or 2 and a matching state `schemaVersion`.
It declares:

- template identity, package, bundle version, and a relative HTML entrypoint;
- bounded capabilities such as `audio.playback`, `media.groups`, `scene.configuration` and `stinger.transitions`;
- the control protocol over server-sent events;
- relative snapshot and event paths;
- query-parameter names for `programId` and `apiBaseUrl`;
- the signal types the renderer accepts; and
- release files, content types, byte counts and SHA-256 digests.

[program-templates-v2.md](program-templates-v2.md) describes contract v2, its projected state and signals, how unknown
members are handled, approved publisher origins and the fetch limits. The JSON Schema is
`docs/contracts/program-template-v2.schema.json`.

## Register a program

Open **Shows**, create or edit a show, paste the manifest URL into **Template URL** and choose **Inspect**. The server
fetches the URL, verifies the contract and shows its capabilities. Saving inspects it again, so a stale preview cannot
bypass validation. **Open renderer** then opens the registered entrypoint with the program ID and API origin. Radio
programs do not take a visual template.

Production accepts HTTPS manifests from the built-in publisher origin `https://cdn.fifthbell.com` and the origins in
the runtime secret's `programTemplateOrigins`. Local development also permits `http://localhost` and
`http://127.0.0.1`. Manifest requests reject credentials, query strings, fragments, unsafe relative paths, non-JSON
responses, bodies over 256 KiB, more than three redirects, and hosts that resolve to non-public networks.

Registration stores the final manifest URL, the normalized contract, its same-origin entrypoint URL and the
verification time. It does not load or run template JavaScript inside the Alcántara application. Never overwrite an
immutable release prefix: publish a new release and register it.

## Public state and signals

For a registered program, `GET /program/:programId/state` and `GET /program/:programId/events` carry a bounded
projection: schema version, program identity, active and staged scene projections, fade-to-black state, timestamps and
version, without operator queues, assignments or stored template metadata. The stream sends only the signals the
manifest declares, and a heartbeat when it declares one.

A program with no registered template gets the whole state and stream. The signed-in console reads its own routes
under `/program/:programId/control/` (see [program-realtime.md](program-realtime.md)).

Removing a program's template URL returns it to the program page's rendering. That is a data change, with no deploy.

## Renderer keys

The pages and machines that serve a program, including a program feed that brings guests in, authenticate with that
program's renderer key (header `X-Renderer-Key`). Keys are issued and rotated per show. See
[renderer-keys.md](renderer-keys.md), including which holders still use the shared key.

## Fifth Bell today

Two Fifth Bell renderings exist, both Brokaw's:

- the program page places `LiveProgram` from the pinned `@fifthbell/brokaw`
  (`frontend/app/components/BrokawFifthBellProgramRenderer.tsx`), with images and audio Alcántara serves from
  `frontend/public/fifthbell`;
- Cronkite publishes immutable Brokaw releases with manifests under
  `https://cdn.fifthbell.com/html/program-releases/<version>/live-program-manifest.json`, which a program can register.

Which one airs Fifth Bell output is not yet decided (gaulatti/alcantara#25). Until it is, both the bundled renderer
and `frontend/public/fifthbell` stay.

## Metrics

The private `/metrics` collector includes:

- `alcantara_dependency_operations_total{dependency="program-template",operation="fetch",result}`;
- `alcantara_dependency_duration_seconds{dependency="program-template",operation="fetch"}`;
- `alcantara_program_sse_connections`;
- `alcantara_program_sse_snapshots_total{result}`; and
- `alcantara_program_template_unknowns_ignored_total{member}`.

Template URLs and identities never appear in metric labels. HTTP route metrics cover response status and latency for
registration and the public state and event requests.
