# MCP endpoint

Alcantara serves the Model Context Protocol at `https://api.alcantara.gaulatti.com/mcp` (gaulatti/alcantara#210). `McpModule` is registered in `AppModule` (#221). The edge nginx config needs no change: its single `location /` already proxies these paths unbuffered.

## Connect a client

Two ways in. Use whichever your client supports.

**OAuth (ChatGPT, Claude, Codex, Cursor and other OAuth-capable clients).** Point the client at `https://api.alcantara.gaulatti.com/mcp`. The client finds the sign-in through the protected-resource metadata, registers through `POST /register`, and signs in through Alcantara's own `/oauth/*` routes with the gaulatti pool ([Signing in through the API](#signing-in-through-the-api)). No client secret is issued and nothing is stored.

**Personal access token (header-only clients).** Send `Authorization: Bearer pmp_pat_…`. Tokens are created in Pompeii. They work only while Alcantara's personal-access-token switch is **on** in Pompeii. It is off by default and Pompeii refuses tokens until it is turned on. The REST API refuses personal access tokens (#209); `/mcp` is the only path that accepts them.

After connecting, call `whoami` to confirm the subject, principal id, client and permissions the server sees for you.

## Routes

| Route | Answer |
|---|---|
| `POST /mcp` | Streamable HTTP, stateless JSON mode. Without a bearer: `401 {"error":"unauthenticated"}` with `WWW-Authenticate: Bearer resource_metadata="…/.well-known/oauth-protected-resource"`. With a bearer Pompeii rejects: `401` with `error="invalid_token"`. Signed in but without `alcantara:access`: `403 {"error":"forbidden"}` with `error="insufficient_scope"`. Too many failed attempts from one client: `429`, `Retry-After: 60`. Pompeii unreachable or saturated: `503`, `Retry-After: 5`. A body over the limit: `413`. |
| `GET /mcp`, `DELETE /mcp` | `405`, `Allow: POST` (no server stream and no session in stateless mode). |
| `GET /.well-known/oauth-protected-resource` (and `/.well-known/oauth-protected-resource/mcp`) | RFC 9728 metadata naming the resource and Alcantara as its authorization server. Public. |
| `GET /.well-known/oauth-authorization-server` | RFC 8414 metadata: `authorization_endpoint` `https://api.alcantara.gaulatti.com/oauth/authorize`, `token_endpoint` `https://api.alcantara.gaulatti.com/oauth/token`, the pool's JWKS and `/register`. Public. |
| `POST /register` | RFC 7591 facade. A registration whose callbacks are all accepted ones (below) gets a client id naming them (`mcp-proxy.` plus base64url of the callbacks and client name); any other well-formed registration gets the shared public client id. `400` otherwise. It stores nothing and issues no secret. `GET /register` answers `405`. |
| `GET /oauth/authorize`, `POST /oauth/authorize`, `GET /oauth/callback`, `POST /oauth/token` | The MCP sign-in, below. Public. |

## Signing in through the API

Cognito redirects only to callbacks listed exactly on the app client, and no list can hold an MCP client's callback: Codex and Claude Code use a loopback address with a random port, and a ChatGPT plugin registers `https://chatgpt.com/connector/oauth/<id>` with a new id each time it is added. So every MCP sign-in goes through Alcantara and its one Cognito callback, `https://api.alcantara.gaulatti.com/oauth/callback` (gaulatti/bastille#34; `backend/src/mcp/mcp-oauth-proxy.service.ts`).

**Accepted callbacks:**
- loopback: `http` on `127.0.0.1`, `localhost` or `[::1]`, any port and path; or
- `https` on exactly `chatgpt.com`, `claude.ai`, `claude.com` or `www.cursor.com`, on the default port, with no user information, any path.

Anything else is refused at `/oauth/authorize` with an HTML page that says which callbacks are accepted, never sent on to Cognito.

| Route | What it does |
|---|---|
| `GET /oauth/authorize` | Requires `response_type=code`, a `state` and an S256 `code_challenge` (else `400`). A callback that is not accepted gets the refusal page (`400`). A `mcp-proxy.` client may use only the callbacks it registered; the shared client may use any accepted callback. For an https callback it answers with the consent page (`200`, no-store, unframeable, with a CSP `form-action` limited to Alcántara, Cognito's origin and the callback's own origin, because Chromium applies `form-action` to the redirects after Continue and Cancel): "<name> (a name the app chose) at <host> wants to use Alcántara as you", the full callback, and Continue and Cancel. For a loopback callback, or once the user continues, it keeps a pending sign-in (10 minutes) and sends the user to Cognito with its own callback, state and S256 challenge, setting an `alcantara_mcp_signin_<first 16 characters of the state>` cookie with a random value (`SameSite=Lax`, because Cognito's return is a cross-site navigation; `HttpOnly`, `Secure`, `Path=/oauth/callback`, 10 minutes). |
| `POST /oauth/authorize` | The consent form: the original request, a nonce and an HMAC-SHA256 over both, keyed per process. Accepted only when the nonce matches the `SameSite=Strict`, `HttpOnly`, `Secure` cookie the page set and the MAC verifies; otherwise `400`. Continue goes to Cognito (`303`); Cancel sends the client `error=access_denied` with its `state` (`303`). |
| `GET /oauth/callback` | Takes the pending sign-in by `state`, once, only in the browser that started it: the sign-in cookie must be present and match (constant-time), or the answer is `400` and the sign-in stays pending for that browser. Every callback clears the cookie it names. Redeems Cognito's code server-side, keeps the tokens under a new single-use 60-second code bound to the client's PKCE challenge, and redirects to the client's callback. A Cognito refusal reaches the client as `error`; a failed exchange as `server_error`. |
| `POST /oauth/token` | Redeems that code once, within 60 seconds, when `client_id`, `redirect_uri` and `code_verifier` match (Cognito's token response, `no-store`); an unknown or used code is `invalid_grant`. A `refresh_token` goes to Cognito unchanged, with a `mcp-proxy.` id replaced by the app client's. |

**Threat model.** Registration is open, so the accepted callbacks are what keep a code from reaching someone else. Codes are delivered only to loopback (the user's own machine) and the allowlisted MCP client hosts; each is single-use, expires in 60 seconds and needs the verifier of its challenge.

**Consent.** Anyone can create their own ChatGPT or Claude connector, register its path and send the owner an authorize link, and Cognito signs an already-signed-in user in silently. So every https callback first shows the consent page, naming the host and the full callback path (the client name is labelled as one the app chose). A cross-site form cannot carry the `SameSite=Strict` cookie, and a request changed after the page was shown fails the MAC. Pending sign-ins, codes and tokens live only in the backend process's memory (at most 1000 each; a restart drops sign-ins in flight), never in the database, a log or a metric label. Adding another https host is a code change to `ALLOWED_HTTPS_HOSTS`, reviewed like any auth change.

## Who gets in

Pompeii authorizes every `/mcp` request for `alcantara:access`, using either:

- a Cognito session from the gaulatti app client: OAuth clients, through the discovery documents above; or
- a Pompeii personal access token (`pmp_pat_…`): header-only clients, with the switch described above.

## Tools

A signed-in caller sees only the tools whose permission they hold, checked again at call time. Built in, all tier R. The first four are the framework's; the radio tools after them are the daily radio reads of #214, each a tool of its own:

| Tool | Permission | What it does |
|---|---|---|
| `whoami` | `alcantara:access` | Your subject, principal id, client and permissions. |
| `list_programs` | `alcantara:program:read` | Program ids, types and song rotation mode. |
| `list_capabilities` | `alcantara:access` | Every capability you may run, paged and searchable, with tier and input schema. |
| `call_capability` | `alcantara:access` | Runs one listed capability through its own permission, tier, dry-run, confirmation, rate-limit and audit path ([action framework](./mcp-action-framework.md)). |
| `get_on_air` | `alcantara:radio:read` | Reports what the radio is playing now: the song (playback request id, start time, seconds remaining), the song announced next, the rotation mode (manual, autoplay or shuffle), whether automation is frozen, the Palazzo connection and the output confidence. |
| `get_queue` | `alcantara:radio:read` | Lists the Play Next queue in order, with each entry's id (entry_id), song id and whether it is the one playing. |
| `get_rundown` | `alcantara:flight:read` | Lists the program's rundown sequences (flight logs) with the active one and, for each clocked log that has not started, a preflight summary (ready and the number of issues). |
| `wait_for_change` | `alcantara:radio:read` | Holds the call open until the radio changes, for at most timeout_seconds (30 at most), and returns the first change or {timeout: true}. |
| `get_as_run` | `alcantara:radio:read` | Lists as-run log rows between from and to (at most 7 days apart), oldest first, at most limit rows (500 at most). |
| `get_royalty_summary` | `alcantara:radio:read` | Counts the performances of each song between from and to (at most 92 days apart): the rows of the SoundExchange export, as data, most played first, at most 500 songs (truncated says when there are more). |
| `search_songs` | `alcantara:song:read` | Searches the song library by title, artist or chart id, at most limit songs (50 at most), ordered by artist. |
| `get_song` | `alcantara:song:read` | Reads one song: its metadata and the stored audio analysis (status, cue in and out, fades, overlap, integrated loudness and true peak). |
| `get_instants` | `alcantara:instant:read` | Lists the instants (short clips): id, name, volume, whether enabled and whether one is free to be a song intro, with the song it introduces in this program. |
| `get_radio_health` | `alcantara:radio:read` | Summarizes the radio's health: the Palazzo connection (connected, degraded, last event), the output confidence (audible, silent, idle, unknown) and the recovery state (the filler prepared, the automation Palazzo reports and whether it answered). |

`backend/src/mcp/mcp.docs.spec.ts` fails when this table and the registry's first-class tools differ, when [MCP capabilities](./mcp-capabilities.md) and the registered capabilities differ, or when a metric named below is not in the backend source.

Everything else is a capability: find it with `list_capabilities`, then run it with `call_capability`. The capabilities by feature are in [MCP capabilities](./mcp-capabilities.md).

Capabilities come from `@McpToolProvider()` classes in the feature modules (#214 to #219). Each one is reachable once its ticket deploys, with no change here.

`backend/src/mcp/mcp.registry.appendix.spec.ts` compiles the real `AppModule` and checks that every registered tool and capability is a row of appendix A (`backend/src/mcp/appendix-a.tsv`), with exactly that row's permission and tier, and that nothing handing out a ticket or credential is registered. Equality with all of appendix A is the tracker's (#210) closing check.

## Tiers

Every capability is one of four tiers. The tier decides whether a dry run exists, whether a confirmation is required, and how often Pompeii is asked again.

| Tier | Meaning | Confirm |
|---|---|---|
| `R` | read | no |
| `W` | reversible write | no |
| `A` | on-air action | yes |
| `D` | destructive | yes |

Tiers `W`, `A` and `D` take an `idempotency_key`. `A` and `D` also take `confirm`, which must echo the target's current `"<id> <name>"`. Where a capability has a dry run, `dry_run: true` returns the plan and writes nothing. The full order of checks is in the [action framework](./mcp-action-framework.md).

## Rate limits

Limits are per identity and per tier, and sliding. They are code constants in `MCP_ACTION_LIMITS` (`mcp.constants.ts`). There is no runtime configuration and no override; a change is a code change.

| Tier | Limit |
|---|---|
| `W` | 60 runs per minute |
| `A` | 6 runs per minute, with at least 10 s between two runs on the same program |
| `D` | 3 runs per minute |

A refused call returns `rate_limited` with `retry_after_seconds`. Dry runs are not recorded against the limit but are still refused while the per-minute allowance is spent. The full rules are in the [action framework](./mcp-action-framework.md#rate-limits).

## Metrics and audit

- `alcantara_mcp_requests_total{tool,tier,result}` counts each request once. `tool` is a registered capability name, or `unknown`. `tier` is `R`, `W`, `A` or `D`. `result` is `ok`, `dry_run`, or one of the closed error codes. No argument, key or identity is ever a label.
- `alcantara_mcp_auth_total` counts authentication outcomes and is separate from the request counter.
- `alcantara_mcp_oauth_total{step,result}` counts each sign-in step (bastille#34): `step` is `authorize`, `callback`, `token` or `refresh`; `result` is `consent`, `cancelled`, `proxied`, `refused`, `unknown_state`, `unbound`, `provider_error`, `exchange_failed`, `issued`, `passed_through`, `upstream_refused` or `upstream_unavailable`. No client id, callback or token is ever a label.
- Each write-tier run writes one audit line with `tool`, `tier`, `result`, `dry_run` and a 12-character hash prefix of the idempotency key. Argument text, titles, confirm strings and key values are never logged.

## What is never returned

Credentials and tickets are not returned by any tool. Capabilities that would hand out a credential, such as a realtime ticket or a guest link, are excluded from appendix A and are not registered.
