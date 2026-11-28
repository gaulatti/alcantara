# Renderer keys per program

The machines that serve a program (the return runner, the on-air contribution worker, and the pages that bring guests
into a program feed) authenticate with a renderer key. Each program has its own key (gaulatti/alcantara#884).

## Storage

`ProgramRendererKey` holds one row per program: the key's SHA-256 (`keyHash`, unique), its `version`, and when it was
created, last rotated and last used. The key itself is never stored, logged or shown again after it is issued. A key is
`alrk_` followed by 32 random bytes in base64url.

`lastUsedAt` is written at most once a minute per program, so polling callers do not write on every call. A failed
write is logged by its error class only and never fails the caller's request.

The migration is additive. Rollback: `DROP TABLE "ProgramRendererKey";`.

## Issue and rotate

| Route | Permission | Answer |
| --- | --- | --- |
| `GET /program/:programId/renderer-key` | `program.read` | `{ programId, exists, version, createdAt, rotatedAt, lastUsedAt }`: never the key or its hash. |
| `POST /program/:programId/renderer-key/rotate` | `program.manage` | The same metadata plus `key`, the new clear key, this once. |

Both answers are `Cache-Control: no-store`. A rotation replaces the previous key at once: the old key stops working
on its next use. Both routes are scoped to the caller's team like every program route, and answer 404 for a program that
does not exist.

Each rotation is recorded as an operator change (who, when, through which route) under the program, with `rendererKey`
named but never valued and `version` valued before and after.

## Console

On **Shows**, a show's actions have **Renderer key**: the version and dates, and **Issue key** or **Rotate key**. A
rotation asks first, because the old key stops working at once. The new key is shown once with a copy button and is
dropped from the page when the panel closes.

## Checks on the calls endpoints

Each endpoint reads `X-Renderer-Key` and the program it acts on (`backend/src/renderer-keys/renderer-auth.service.ts`):

| Endpoint | Program | Accepts |
| --- | --- | --- |
| `POST /webrtc/renderer-token` | body `programId` | that program's key, or the shared key |
| `POST /webrtc/renderer-state` | body `programId` | that program's key, or the shared key |
| `POST /webrtc/renderer-source-token` | body `programId` | that program's key, or the shared key |
| `POST /webrtc/return-audio-ticket` | body `programId` | that program's key, or the shared key |
| `GET /webrtc/on-air` and `GET /webrtc/on-air/stream` | query `programId` | that program's key, or the shared key |
| `GET /webrtc/return-routers` | every program | the fleet key, or the shared key |

- A valid key for another program is refused with `403`. Any other credential (the fleet key on a program endpoint, a
  program key on the router list, a wrong key or none) is refused with `401`.
- The stream answers `401` or `403` before it opens, never as a stream that breaks.
- The fleet key is the runtime secret's optional `webrtcFleetKey` (`WEBRTC_FLEET_KEY`, at least 32 characters). The shared
  key is `webrtcRendererKey` (`WEBRTC_RENDERER_KEY`).

## Shared-key fallback and its closer

The shared key is accepted on every endpoint until it is removed. Each acceptance is counted and logged with its program
and endpoint (`Shared renderer key accepted for program <id> on <endpoint>`), never with a key's value, so its last
use shows. The shared key is removed once production shows no shared-key acceptance for 24 hours.

## Metric

`alcantara_webrtc_renderer_auth_total{endpoint,credential,result}`:

- `endpoint`: `renderer_token`, `renderer_state`, `renderer_source_token`, `return_routers`, `return_audio_ticket` or
  `on_air`;
- `credential`: the one that matched, `program`, `shared`, `fleet` or `none`;
- `result`: `accepted` or `refused`.

Each endpoint's `program` and `shared` acceptances are exposed from zero. For the closer, read
`sum(increase(alcantara_webrtc_renderer_auth_total{credential="shared",result="accepted"}[24h]))`.

## Holders

The return runner, the contribution worker and the program pages move to per-program keys in the next step of #884. Until
then they keep the shared key, which is still accepted.
