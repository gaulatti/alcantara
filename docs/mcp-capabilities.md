# MCP capabilities

Capabilities are the Alcantara console actions an MCP client reaches through
`list_capabilities` and `call_capability` (tracker: gaulatti/alcantara#210).
A capability is a `McpToolSpec` with `firstClass: false`, built by an
`@Injectable()` class decorated with `@McpToolProvider()` and listed in the
providers of the module whose services it calls. The registry finds it through
Nest discovery; appendix A of the tracker is the binding list of names,
permissions and tiers. Capabilities call the services in process with the
caller already authorized; they never call the REST API, and the four routes
whose answer is a credential are not capabilities.

Rules that hold for every capability in these files:

- The permission is the route's own, checked by the registry at call time.
- User-entered text (names, descriptions, chyron text, scene and layout
  settings, template manifests, media addresses, flight items) is moved, whole
  and unread, under an `untrusted` key beside its siblings, and the description
  ends with the untrusted-text note.
- An answer that carries a credential field (`token`, `ticket`, `secret`,
  `password`, `signature`, `credentials`, `authorization`, `apikey`) or a signed
  link (`X-Amz-Signature`, `?token=`) is withheld as `unavailable` instead of
  being returned.
- A service's own refusal is reported as the closed MCP code: 400 `invalid`,
  403 `forbidden`, 404 or "... not found" `not_found`, 409 or "... already
  exists" `conflict`; anything else stays `unavailable`.
- Metrics need nothing extra: the registry and executor count every call under
  `alcantara_mcp_requests_total{tool,tier,result}` with the registered tool
  name as the only label value.

## Program, scenes, layouts and media groups (#216)

Files: `backend/src/mcp/capabilities/{program,scenes,layouts,media-groups}.ts`,
shared helpers in `support.ts`.

### Read capabilities

| Capability | Permission | Answers like |
|---|---|---|
| `program_list_programs` | `program.read` | `GET /program` (all programs, scenes, media groups, stingers, flight sequences) |
| `program_get_staged_scene_by_id` | `program.read` | `GET /program/:programId/stage` |
| `scene_find_all` | `scene.read` | `GET /scenes` |
| `scene_find_one` | `scene.read` | `GET /scenes/:id`; a missing scene is `not_found` (REST answers an empty 200) |
| `layout_find_all` | `layout.read` | `GET /layouts` |
| `layout_find_one` | `layout.read` | `GET /layouts/:id`; a missing layout is `not_found` |
| `media_group_find_all` | `media.read` | `GET /media-groups`; `limit` is 1 to 100 (default 20), so a read is always bounded |
