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

## Over MCP

| Capability | Permission | Tier | Answer |
| --- | --- | --- | --- |
| `webrtc_renderer_key` | `program.read` | R | The metadata above, never the key or its hash. |
| `webrtc_rotate_renderer_key` | `program.manage` | A (dry run, then confirm by program) | `{ programId, version, rotatedAt }` only. |

The MCP rotation never returns the new key, so a key never lands in a client's transcript. Use it to revoke a key;
issue a key to hand out from the Console panel above, which shows it once. The rotation is recorded as an operator change
like the console's, under the capability `webrtc_rotate_renderer_key`.

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
- The fleet key is the runtime secret's optional `webrtcFleetKey` (`WEBRTC_FLEET_KEY`). The shared key is
  `webrtcRendererKey` (`WEBRTC_RENDERER_KEY`). Each program's key, for the machines that serve it, is in
  `webrtcProgramKeys` (`{ "<programId>": "alrk_…" }`), which the backend never reads: it checks a key by its stored hash.

## Program writes from the renderer page

Two program writes are made by the on-air page, which has no sign-in
(`backend/src/renderer-keys/renderer-write.guard.ts`):

| Route | Endpoint label |
| --- | --- |
| `POST /program/:programId/audio-meter` | `audio_meter` |
| `POST /program/:programId/countdown/complete` | `countdown_complete` |

Each takes, in this order:

- an `Authorization` header: a signed-in session with `program.operate`, checked as on every signed-in route. A token
  that fails is counted as `credential="session"`, `result="refused"`, and refused (`401`/`403`) unless the request
  also presents `X-Renderer-Key`, which then decides (a page whose session expired keeps working on its key);
- otherwise `X-Renderer-Key`: this program's key, or the shared key until it is removed, as on the calls endpoints;
- otherwise nothing: still accepted, counted as `credential="none"`, `result="accepted"`, and logged as
  `Uncredentialed <endpoint> accepted for program <id>`.

The program page sends the renderer key it was opened with (`#key=` in its URL, kept for the session) on the countdown
write. A request with no credential is refused once production shows none on either write for 24 hours:
`sum(increase(alcantara_webrtc_renderer_auth_total{endpoint=~"audio_meter|countdown_complete",credential="none",result="accepted"}[24h]))`.

## Shared-key fallback and its closer

The shared key is accepted on every endpoint until it is removed, and a program write with no credential is still
accepted. Each such acceptance is counted and logged with its program and endpoint, never with a key's value, so its
last use shows.

The closer refuses both. It lands only when `scripts/renderer-auth-closer-gate.mjs` exits 0:

```sh
node scripts/renderer-auth-closer-gate.mjs
```

It prints one line per claim (`<1|0> <name> <time> <evidence>`) and exits 0 only when every one holds:

| Line | 1 when |
| --- | --- |
| `fallback_unused_24h` | `sum(increase(alcantara_webrtc_renderer_auth_total{credential=~"shared\|none",result="accepted"}[24h]))` is exactly 0. |
| `window_whole` | The metric already had series 24 hours ago, so the window is not shorter than it says. |
| `scrape_whole_24h` | Every target carrying the metric had `up` at 1 for the whole 24 hours, with at least 23.5 hours' worth of scrapes at the last hour's rate, so no scrape gap hides a use. |
| `fleet_key_in_secret` | The runtime secret holds `webrtcFleetKey`, which the return runner needs once the shared key is gone. |

An empty, partial (with warnings), errored or unreadable answer is 0. The queries go to Milano's Prometheus through
`PROMQL_CMD`, a command with `{query}` replaced by the URL-encoded query. The default runs `wget` inside
`milano-prometheus-1` over SSH to Helix. The secret's state comes from `SECRET_STATUS_CMD`, which defaults to
`backend/scripts/renderer-secret-status.mjs` in the backend image with the caller's AWS credentials. That script prints
whether the fleet and shared keys are present and which programs have a key, never a value.

## Metric

`alcantara_webrtc_renderer_auth_total{endpoint,credential,result}`:

- `endpoint`: `renderer_token`, `renderer_state`, `renderer_source_token`, `return_routers`, `return_audio_ticket`,
  `on_air`, `audio_meter` or `countdown_complete`;
- `credential`: the one that matched, `program`, `shared`, `fleet`, `session` (program writes only) or `none`;
- `result`: `accepted` or `refused`.

Each endpoint's `program` and `shared` acceptances, and each program write's `none` acceptance, are exposed from zero. For the closer, read
`sum(increase(alcantara_webrtc_renderer_auth_total{credential="shared",result="accepted"}[24h]))`.

## Holders

| Holder | Presents | From |
| --- | --- | --- |
| Return runner (Helix) | the fleet key on the router list; each program's key on its page | `webrtcFleetKey`, `webrtcProgramKeys`, each else the shared key |
| Contribution worker (cumulus) | its station's key on every call | its program's `webrtcProgramKeys` entry, else the shared key |
| Pilot's Program window (Carmencita) | its show's key in the page's `#key=` | the key the operator pastes into the pilot |
| A program page opened by hand | the `#key=` it was opened with | the Shows panel |

`backend/scripts/place-renderer-keys.cjs` issues the keys and places them in the secret (infra/README.md, "Placing the
programs' renderer keys"); the holders' deploy scripts then write them into their env files.

A page whose key is refused says so without drawing on the picture: its root gets `data-renderer-key="changed"` on a
`401` (the key was rotated) or `"other-program"` on a `403`, the console logs `[renderer-key] renderer key changed,
reload`, and a `renderer-key-refused` event fires for the page's holder. Reopening it with the new `#key=` clears it.
