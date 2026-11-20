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

### Write, on-air and destructive capabilities

Every W, A and D capability has a dry run; every A and D capability has a
confirm target `{id, name}` (so the dry run returns the `confirm` string to
echo). Arguments mirror the controller's body (snake_case), and a capability
reaches the same service method with the same values: the specs call the real
controller and the capability against one set of fakes and compare the service
calls and the answers.

**Answers that are smaller than the console's.** A stored outcome is kept whole
in memory for ten minutes, so the capabilities whose route answers a whole
program, a playlist or a media group answer with ids instead (the whole
answer is one read away): the program state routes (create, rename, add and
remove scene, media group and stinger, activate, fade to black, off air) answer
`{program_id, type, active_scene_id, staged_scene_id, fade_to_black, scene_ids,
media_group_ids, stinger_ids, version}`; the scene instant routes answer the
playback without the address of the audio; `program_update_program_audio_bus_by_id`
answers the mixer settings and version without the playlist;
`media_group_create` and `media_group_update` answer the media ids without the
media rows.

**The confirm name of a program action** is the program's live stamp
(`scene:<id|null> fade:<0|1> song:<0|1> queue:<n>`), so a plan made before
something went on or off air is refused as `confirm_mismatch`. The confirm
name of a scene, layout or media group action is the target's name.

**The routes with no program id** (`/program/activate`, `/off-air`,
`/song/off-air`, `/reload`) act on the default program `main`; their
capabilities take `program_id: "main"` (the only value) so the executor spaces
on-air runs on the program. `PUT /program/broadcast-settings` is global and has
no program.

| Area | R | W | A | D | Total |
|---|---|---|---|---|---|
| program (not flight, radio, recording or broadcast) | 2 | 7 | 16 | 4 | 29 |
| scenes | 2 | 2 | 4 | 1 | 9 |
| layouts | 2 | 2 | 0 | 1 | 5 |
| media groups | 1 | 2 | 0 | 1 | 4 |

### Step 0 of every D row: what the console does today

The console deletes in every case below, whatever is on air. The capability
refuses with `on_air` (checked again at run time, so a plan made earlier
cannot cut a live target), and its dry run says what is lost and whether it
can be recovered. The dry run of a refused target starts `REFUSED (on_air)` and
reports `onAir: true`.

| Capability | The console today | The capability |
|---|---|---|
| `program_delete_program` | Deletes the program row. The database removes its scene, media group and stinger assignments, flight sequences, radio settings and the rest by cascade, and its in-memory playback state is dropped; a program with a broadcast destination selection fails with an unexplained 500 (foreign key). It never looks at what is live. | `on_air` while a scene or fade to black is on air, a song or scene instant is playing, songs are queued or a flight sequence is active. Not recoverable. A foreign-key refusal is `conflict`. |
| `program_remove_scene_from_program` | Deletes the assignment; if the scene is on air or staged there it clears that (the picture goes blank) and stops its background audio. | `on_air` while the scene is on air, staged, or playing its background audio on that program. Recoverable (the scene returns at the end of the list). `not_found` when the scene is not assigned. |
| `program_remove_media_group_from_program` | Deletes the assignment, whatever is on air. | `on_air` while the program has a scene or fade to black on air, because its live page reads its media groups. Recoverable. |
| `program_remove_stinger_from_program` | Deletes the assignment, whatever is on air. | `on_air` while the program has a scene or fade to black on air, because its scene changes use its stingers. Recoverable. |
| `scene_remove` | Clears the scene from every program where it is on air (`scene_cleared`, the picture goes blank), deletes it and its assignments by cascade, and leaves a staged pointer to it dangling. | `on_air` while the scene is on air or staged on any program. Not recoverable (layout choice, chyron text, metadata and bracket state are gone); the dry run lists every program assignment lost. |
| `layout_remove` | Deletes the layout; the database refuses with an unexplained 500 while any scene still uses it. It never looks at what is on air. | `on_air` while a scene of the layout is on air or staged; `conflict` (a plain message) while any scene still uses it. Not recoverable. |
| `media_group_remove` | Deletes the group, its item list, its program assignments and the legacy label that mirrors it, whatever is on air; the media stay. | `on_air` while a program the group is assigned to has a scene or fade to black on air. Not recoverable (the grouping, its order and the assignments; a new group of the same media gets a new id). The dry run lists the programs it is assigned to. |

An assignment to a program that is off air is not an `on_air` case: the dry run
lists it as lost and the capability proceeds after the confirm, as the console
does.

### Other behavior worth knowing

- `program_remove_queued_program_song_by_id` is a W row (appendix A), although
  its siblings that queue and reorder are A rows; it needs `program.operate`.
- Reading a scene or layout that is not there is `not_found`; REST answers an
  empty 200.
- A W, A or D answer that would carry a credential is withheld as `unavailable`
  after the service has acted; no capability of this area returns one today.
- Metrics: the area adds no metric. Calls count under the executor's
  `alcantara_mcp_requests_total{tool,tier,result}` with the registered
  capability name, tier and a closed result as the only labels.
