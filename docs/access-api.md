# Access: the backend, the configuration and the metrics (gaulatti/alcantara#224)

What a person sees is in [Access](access.md). This page is for operators and
developers: the routes the page calls, how Alcántara reaches Pompeii, and what it
counts. Alcántara **stores nothing** for access; every answer is Pompeii's.

## Routes

All `/access/*` routes sit behind the normal guard: they need only a signed-in
person (`alcantara:access`). A personal access token is refused as the person
(`401`, before any call): the page forwards only the interactive session bearer.
Pompeii makes every permission decision, including `alcantara:access:manage` for
the token switch and for grants. Bodies are snake_case JSON; timestamps are
RFC 3339 and `""` means none.

| Route | Pompeii RPC | Answer `200` |
|---|---|---|
| `GET /access/tokens` | `ListMyTokens` | `{"tokens":[Token]}` |
| `POST /access/tokens` | `CreateMyToken` | `{"token":Token,"value":"pmp_pat_…"}`: the only answer that carries a value |
| `DELETE /access/tokens/:id` | `RevokeMyToken` | `{}` (`:id` is the token's UUID) |
| `GET /access/token-switch` | `GetTokenSwitch` | `{"enabled":bool}` |
| `PUT /access/token-switch` | `SetTokenSwitch` | `{"enabled":bool}` |
| `GET /access/roles` | `ListRoles` | `{"roles":[{"id","name","permissions"}]}` (`403` means the caller lacks the manage key) |
| `GET /access/grants` | `ListGrants` | `{"grants":[GrantRecord]}` |
| `POST /access/grants` | `Grant` | `GrantRecord` (body `{"user_id","role_id"}`, both positive integers) |
| `DELETE /access/grants/:id` | `Revoke` | `{}` |
| `GET /access/history?limit=&before=` | `ListAccessHistory` | `{"entries":[HistoryEntry]}` (`limit` 1 to 200, default 50) |
| `GET /access/my-permissions` | none | `{"permissions":[…]}` |

`GET /access/my-permissions` is the caller's own effective keys that start with
`alcantara:`, deduplicated and sorted, read from the decision the guard already
made for the request (no Pompeii call, no service credential; it answers while
the access RPCs are unavailable). A wildcard `*` is never expanded or returned.
The page uses it for its permission picker and falls back to typed keys without it.

Requests are forwarded with `team_id` 0, `via_client` `console` and the
`Authorization` header exactly as received. A body of the wrong shape (a missing
name, a non-integer id, a `limit` over 200) is `400 invalid_request` without a call.

## Errors

The body is `{"error": …}` and never carries Pompeii's message.

| Pompeii | HTTP | `error` |
|---|---|---|
| `UNAUTHENTICATED` | 401 | `unauthenticated` |
| `PERMISSION_DENIED` | 403 | `forbidden` |
| `INVALID_ARGUMENT` | 400 | `invalid_request` |
| `FAILED_PRECONDITION` | 409 | `tokens_off` (the token switch is off) |
| `NOT_FOUND` | 404 | `not_found` |
| `UNAVAILABLE`, `DEADLINE_EXCEEDED`, any other code, or no service credential | 503 | `access_unavailable` |

The page shows "not available yet" for the whole panel when any call answers
`503`, and hides Token switch and People when `GET /access/roles` answers `403`.

## Reaching Pompeii

- gRPC `pompeii.access.v1.ApplicationAccessService` (`backend/src/proto/application_access.proto`)
  at the same endpoint as `Authorize`, with the same TLS, deadline
  (`POMPEII_GRPC_TIMEOUT_MS`) and channel. The access calls ride the
  authorization client's channel, so a call that ends in `DEADLINE_EXCEEDED` or
  `UNAVAILABLE` replaces the channel exactly as an authorization call does
  ([channel replacement](../README.md), gaulatti/alcantara#225).
- The service credential goes in the gRPC metadata `x-pompeii-service-credential`.
  It comes from the application secret key **`POMPEII_ACCESS_CREDENTIAL`**,
  which the secrets loader copies into the environment (an allow-listed optional
  key). Absent or blank, every `/access/*` route answers `503 access_unavailable`
  without calling Pompeii, and startup is not affected: the page ships before
  the credential exists. Locally it is absent unless Compose points at a local
  Pompeii; a malformed (non-string) value fails startup like any other secret field.
- A misconfigured credential comes back `UNAUTHENTICATED`, which looks like a bad
  session. Alcántara logs every access `UNAUTHENTICATED` at warn level as
  `Pompeii refused an access call on <route> as unauthenticated: check POMPEII_ACCESS_CREDENTIAL and the sign-in client`,
  without the credential or Pompeii's message.
- The session must come from one of Alcántara's own sign-in clients in Pompeii; a
  session for another application is `unauthenticated`.

## What is never logged

The token value, the bearer and the service credential never reach a log line or
a metric label. The HTTP layer logs no request or response body, `AccessService`
logs only a route name and a gRPC code number, and a test plants a token value, a
bearer and a credential and asserts none appears in any log or in `/metrics`.

## Metrics

| Metric | Labels | Meaning |
|---|---|---|
| `alcantara_access_requests_total` | `route`, `result` | Calls to Pompeii's access service. `route` is one of `tokens_list`, `token_create`, `token_revoke`, `token_switch_get`, `token_switch_set`, `roles_list`, `grants_list`, `grant_create`, `grant_revoke`, `history_list`. `result` is `ok`, `unauthenticated`, `forbidden`, `invalid_request`, `tokens_off`, `not_found`, `unavailable` or `not_configured` (no credential, nothing called). Every pair starts at 0. |
| `alcantara_access_request_duration_seconds` | `route` | Duration of those calls (histogram). |
| `alcantara_http_requests_total{route="access"}` | | The `/access/*` requests as HTTP, under their own route group. |
| `alcantara_pompeii_channel_resets_total` | `reason` | Also counts a channel replaced by an access call. |

An unexpected label value is dropped, never recorded. A rising
`result="unavailable"` means Pompeii or the network; `unauthenticated` right
after a deploy usually means the credential; `not_configured` means the secret
has no `POMPEII_ACCESS_CREDENTIAL` yet.

## MCP

The same calls are available to MCP clients as nine capabilities with
`via_client: mcp`; see [MCP capabilities](mcp-capabilities.md#access-gaulattialcantara224).
