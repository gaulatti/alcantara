# MCP endpoint

Alcantara serves the Model Context Protocol at `https://api.alcantara.gaulatti.com/mcp` (gaulatti/alcantara#210). `McpModule` is registered in `AppModule` (#221). The edge nginx config needs no change: its single `location /` already proxies these paths unbuffered.

## Connect a client

Two ways in. Use whichever your client supports.

**OAuth (Claude, Grok and other OAuth-capable clients).** Point the client at `https://api.alcantara.gaulatti.com/mcp`. The client finds the sign-in through the protected-resource metadata, signs in with the gaulatti pool, and registers through `POST /register`. Registration returns the shared public client id for a well-formed callback and stores nothing. No client secret is issued.

**Personal access token (header-only clients).** Send `Authorization: Bearer pmp_pat_…`. Tokens are created in Pompeii. They work only while Alcantara's personal-access-token switch is **on** in Pompeii. It is off by default and Pompeii refuses tokens until it is turned on. The REST API refuses personal access tokens (#209); `/mcp` is the only path that accepts them.

After connecting, call `whoami` to confirm the subject, principal id, client and permissions the server sees for you.

## Routes

| Route | Answer |
|---|---|
| `POST /mcp` | Streamable HTTP, stateless JSON mode. Without a bearer: `401 {"error":"unauthenticated"}` with `WWW-Authenticate: Bearer resource_metadata="…/.well-known/oauth-protected-resource"`. With a bearer Pompeii rejects: `401` with `error="invalid_token"`. Signed in but without `alcantara:access`: `403 {"error":"forbidden"}` with `error="insufficient_scope"`. Too many failed attempts from one client: `429`, `Retry-After: 60`. Pompeii unreachable or saturated: `503`, `Retry-After: 5`. A body over the limit: `413`. |
| `GET /mcp`, `DELETE /mcp` | `405`, `Allow: POST` (no server stream and no session in stateless mode). |
| `GET /.well-known/oauth-protected-resource` (and `/.well-known/oauth-protected-resource/mcp`) | RFC 9728 metadata naming the resource and Alcantara as its authorization server. Public. |
| `GET /.well-known/oauth-authorization-server` | RFC 8414 metadata pointing at the gaulatti pool's hosted sign-in (`buendia.gaulatti.com`) and `/register`. Public. |
| `POST /register` | RFC 7591 facade. It returns the shared public client id for well-formed callbacks and `400` otherwise. It stores nothing and issues no secret. `GET /register` answers `405`. |

## Who gets in

Pompeii authorizes every `/mcp` request for `alcantara:access`, using either:

- a Cognito session from the gaulatti app client: OAuth clients, through the discovery documents above; or
- a Pompeii personal access token (`pmp_pat_…`): header-only clients, with the switch described above.

## Tools

A signed-in caller sees only the tools whose permission they hold, checked again at call time. Built in, all tier R:

| Tool | Permission | What it does |
|---|---|---|
| `whoami` | `alcantara:access` | Your subject, principal id, client and permissions. |
| `list_programs` | `alcantara:program:read` | Program ids, types and song rotation mode. |
| `list_capabilities` | `alcantara:access` | Every capability you may run, paged and searchable, with tier and input schema. |
| `call_capability` | `alcantara:access` | Runs one listed capability through its own permission, tier, dry-run, confirmation, rate-limit and audit path ([action framework](./mcp-action-framework.md)). |

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
- Each write-tier run writes one audit line with `tool`, `tier`, `result`, `dry_run` and a 12-character hash prefix of the idempotency key. Argument text, titles, confirm strings and key values are never logged.

## What is never returned

Credentials and tickets are not returned by any tool. Capabilities that would hand out a credential, such as a realtime ticket or a guest link, are excluded from appendix A and are not registered.
