# Program template contracts v2

The broadcast overlay control system manages program state and event dispatching. Visual rendering templates execute externally and communicate with the system via machine-readable contracts and server-sent events.

## Published contract

The v2 contract specifies `kind: alcantara.program-template`, `contractVersion: 2`, and state `schemaVersion: 2`. The full JSON Schema is committed at `docs/contracts/program-template-v2.schema.json`.

A contract v2 manifest declares:

- Template identity, package, bundle version, and relative HTML entrypoint;
- Declared capabilities bounded to the schema enum:
  - `audio.playback`
  - `media.groups`
  - `scene.configuration`
  - `stinger.transitions`
  - `audience.interaction`
  - `data.chart-provider`
  - `source.external-video`
  - `source.webrtc-guest`
  - `sequence.song`
  - `sequence.chyron`
  - `media.slideshow`
  - `display.clock`
  - `display.ticker`
  - `display.scoreboard`
- Control protocol `alcantara.program.v2` over `server-sent-events`;
- Relative snapshot path `state` and events path `events`;
- Runtime query parameter names for `programId` and `apiBaseUrl`;
- Supported signal types matching the allowed signal catalog;
- Optional release files with key, byte count, MIME content type, and SHA-256 digest. As the schema allows, a file entry may carry additional properties; they are accepted and not stored.

A v2 registration receives state `schemaVersion: 2` on the `program_state_snapshot` event, on every projected state (`GET /program/:programId/state` and state-bearing signals) and on every projected signal. A v1 registration continues to receive `schemaVersion: 1`.

## Signals and event projection

For contract v2 registrations, the event stream (`GET /program/:programId/events`) projects signals according to the v2 specification:

| Signal | Projected fields |
| --- | --- |
| `chyron_update` | `sceneId`, `chyronText` |
| `fade_to_black` | `active` |
| `song_playback_active` | `songId`, `title`, `artist`, `coverUrl`, `durationMs`, `startedAt`, `externalChartProvider`, `externalChartRank`, `externalChartSpins` |
| `song_playback_update` | `songId`, `positionMs`, `durationMs` |
| `song_queue_update` | `items: [{songId, title, artist}]` |
| `audio_levels` | `rms`, `peak` |
| `audience_interaction_draw_start` | `sceneId`, `componentType`, `drawId`, `durationSeconds`, `candidateIds`, `slot: {matchId, field}` |
| `audience_interaction_draw_end` | `sceneId`, `componentType`, `drawId`, `selectedId` |

`candidateIds` is always present on `audience_interaction_draw_start`: it lists the draw's candidate song IDs in the order drawn (the scenes service broadcasts them as `songIds`), and is an empty list when a draw carries none.

Existing v1 registrations remain supported and unchanged. v2-only signals are projected only for manifests with `contractVersion: 2`.

## Publisher origins and security

Template registration fetches the declared manifest over HTTPS and enforces strict network boundaries:

1. **Approved publisher origins**: In production, manifests must originate from an approved publisher origin. The deployment's runtime secret contract allowlists additional approved publisher origins via `programTemplateOrigins`, a comma-separated list of HTTPS origins. The list is empty by default. In production the secret is the only source: when it omits `programTemplateOrigins`, a `PROGRAM_TEMPLATE_ORIGINS` value left in the container environment is discarded and no additional origin is approved. Outside production, `PROGRAM_TEMPLATE_ORIGINS` in the local environment is used as before.
2. **Origin normalization**: Each configured origin is normalized before it is compared, so `https://Templates.Example.test/`, `https://templates.example.test:443` and `https://templates.example.test` are the same origin. Scheme and host must still match: a different host is refused.
3. **CORS configuration**: The normalized origins in `programTemplateOrigins` are permitted by the API CORS policy.
4. **SSRF protection**: Manifest destinations must resolve only to public network IP addresses. Loopback, private (RFC 1918), link-local, documentation, and multicast ranges are rejected.
5. **Request limits**: Redirects are followed up to three hops, checking each destination. Responses are capped at 256 KiB and must return a JSON content type.

## Rollback

Rollback is immediate and data-driven:
- Emptying the `programTemplateOrigins` secret field prevents new v2 template registrations from custom origins.
- Existing v1 registrations continue operating without modification.
