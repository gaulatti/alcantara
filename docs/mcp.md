# MCP endpoint

Alcantara serves the Model Context Protocol at `https://api.alcantara.gaulatti.com/mcp` (gaulatti/alcantara#210). `McpModule` is registered in `AppModule` (#221). The edge nginx config needs no change: its single `location /` already proxies these paths unbuffered.

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
- a Pompeii personal access token (`pmp_pat_…`): header-only clients. This needs Alcantara's personal-access-token switch **on** in Pompeii. It's off by default, and Pompeii refuses tokens until it's on.

The REST API's refusal of personal access tokens (#209) is unchanged. `/mcp` is the only path that accepts them.

## Tools

A signed-in caller sees only the tools whose permission they hold, checked again at call time. Built in, all tier R:

| Tool | Permission | What it does |
|---|---|---|
| `whoami` | `alcantara:access` | Your subject, principal id, client and permissions. |
| `list_programs` | `alcantara:program:read` | Program ids, types and song rotation mode. |
| `list_capabilities` | `alcantara:access` | Every capability you may run, paged and searchable, with tier and input schema. |
| `call_capability` | `alcantara:access` | Runs one listed capability through its own permission, tier, dry-run, confirmation, rate-limit and audit path ([action framework](./mcp-action-framework.md)). |

Capabilities come from `@McpToolProvider()` classes in the feature modules (#214 to #219). Each one is reachable once its ticket deploys, with no change here.

`backend/src/mcp/mcp.registry.appendix.spec.ts` compiles the real `AppModule` and checks that every registered tool and capability is a row of appendix A (`backend/src/mcp/appendix-a.tsv`), with exactly that row's permission and tier, and that nothing handing out a ticket or credential is registered. Equality with all of appendix A is the tracker's (#210) closing check.
