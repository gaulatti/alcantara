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

## Songs, media, media assets, labels and similarity (#218)

Files: `backend/src/mcp/capabilities/{songs,media,media-assets,similarity}.ts`.
`SongsMcpTools`, `MediaMcpTools` and `MediaAssetsMcpTools` are providers of
their own modules; `SimilarityMcpTools` is a provider of the radio module.

### Read capabilities

| Capability | Permission | Answers like |
|---|---|---|
| `song_find_all` | `song.read` | `GET /songs`; `limit` is 1 to 200 (default 50), where the console also accepts 0 for the whole catalog |
| `song_find_one` | `song.read` | `GET /songs/:id` (a missing song is `not_found`) |
| `media_find_all` | `media.read` | `GET /media` (limit at most 200, default 50) |
| `media_find_one` | `media.read` | `GET /media/:id` |
| `media_asset_find_all` | `access` | `GET /media-assets`, limited to the assets the caller may read |
| `media_asset_find_one` | `access` | `GET /media-assets/:id` |
| `media_asset_find_labels` | `access` | `GET /media-labels` |
| `media_asset_find_label` | `access` | `GET /media-labels/:id` |
| `radio_similarity_coverage` | `radio.read` | `GET /radio/:programId/similarity/coverage` |
| `radio_similarity_decisions` | `radio.read` | `GET /radio/:programId/similarity/decisions` (limit 1 to 200, default 50) |
| `radio_similarity_export` | `radio.manage` | `GET /radio/:programId/similarity/export`, one page of `songs` (see below) |

- Asset and label reads pass the caller's own permissions to the service, as the
  console's guard does, so a caller sees only the assets the service lets that
  caller read.
- `radio_similarity_export` answers the console's body with `songs` reduced to
  one page (`offset`, `limit`: default 200, at most 1000) and a `total` of the
  whole list, because the console's answer lists every song with its address.
- Text typed or imported by people (a song's artist, title and addresses, an
  asset's name and address, a label's name and description, a media image's name
  and address) is under `untrusted`.

### Write and destructive capabilities

Every W and D capability has a dry run; every D capability has a confirm target
`{id, name}`. There are no A rows in this area. Arguments mirror the
controller's body (snake_case) and reach the same service method with the same
values: the specs call the real controller and the capability against one set
of fakes and compare the service calls and the answers.

| Area | R | W | A | D | Total |
|---|---|---|---|---|---|
| songs | 2 | 2 | 0 | 1 | 5 |
| media | 2 | 2 | 0 | 1 | 5 |
| media assets and labels | 4 | 5 | 0 | 2 | 11 |
| radio similarity | 3 | 1 | 0 | 0 | 4 |

- `song_create` and `song_update` take the song fields of the console's body
  (`artist`, `title`, `audio_url`, `cover_url`, `duration_ms`,
  `external_chart_id`, `external_chart_rank`, `external_chart_spins`,
  `external_chart_provider`, `enabled`, `program_id`, `intro_instant_id`); a
  field left out is not sent. `song_update` flags `onAir` in its dry run while
  a program is playing the song.
- The label writes (`media_asset_create_label`, `media_asset_update_label`,
  `media_asset_replace_label_assets`) answer the label's ids, text, times,
  `assetCount` and `assetIds`, not every asset (a stored outcome is kept whole
  in memory); `media_asset_find_label` lists the assets.
- `radio_similarity_upload` takes `program_id` (the route's, which the service
  does not read) and `upload`, the console's body; the service validates it and
  answers per song.
- **Permissions of the media asset and label writes.** The seven writes of the
  media-assets area need `media.manage`; a caller without it does not see them.
  The service then decides from the caller's own permissions: a background audio
  needs `scene.manage`, a label write any manage permission, an asset write the
  manage permission of its kind.
- **Stricter than the console.** The four D capabilities (`song_remove`,
  `media_remove`, `media_asset_remove_standalone_asset`,
  `media_asset_remove_label`) refuse with `on_air` where the console deletes,
  and `song_remove` also refuses a song that is in any program's rotation; each
  description says so.

### Step 0 of every D row: what the console does today

| Capability | The console today | The capability |
|---|---|---|
| `song_remove` | Checks the song exists, then deletes it, its media asset and cover link, its chart identity, intro assignment and embeddings in one transaction. It never looks at what is playing, queued or in a song sequence. | `on_air` while a program is playing the song, has it in its Play Next queue (a sequence item or a catalog entry) or lists it in its song sequence. Not recoverable (a new song gets a new id and must be analysed and embedded again; the file stays in storage). |
| `media_remove` | Checks the image exists, deletes it and its media asset, removes it from every media group that holds it (renumbering their items and refreshing the legacy slideshow label). Never looks at what is on air. | `on_air` while a program that reads a group holding the image has a scene or fade to black on air, or a scene on air or staged names the image address in its settings. Not recoverable. The dry run lists the programs that read it. |
| `media_asset_remove_standalone_asset` | Deletes an asset the caller may manage that is not an image, clip, song, cover or transition (the service answers 400 for those); its label assignments go by cascade. Never looks at what is on air. | `on_air` while a scene on air or staged names the asset id or address in its settings. Not recoverable. The dry run lists its label assignments and the programs with a scene that names it. |
| `media_asset_remove_label` | Deletes the label and its assignments (the assets stay); a legacy slideshow label deletes the media group it mirrors, with its program assignments. Never looks at what is on air. | `on_air` while a scene on air or staged names the label id, or a program that reads the mirrored group has a scene or fade to black on air. Not recoverable. |

An assignment to a program that is off air is not an `on_air` case: the dry run
lists it as lost and the capability proceeds after the confirm.

### Import media by URL (`import_media_from_url`)

File: `backend/src/mcp/capabilities/media-import.ts`; the work is
`UploadsService.importFromUrl`. A W capability with `upload.create`, taking
`url` (at most 2000 characters) and `kind` (`instant`, `background` or `song`:
the console's audio uploads; artwork and stinger are not importable).

- **It covers three `upload_*` rows.** Appendix A's `upload_instant`,
  `upload_background` and `upload_song` are multipart routes that an MCP
  client cannot use; they are marked `covered by import_media_from_url` in the
  tsv and are not capabilities of their own. `upload_artwork` and
  `upload_stinger` stay plain rows: artwork and stinger are not importable kinds
  (image and video types); their import is tracked in #226. The console has no import route: its
  uploads are multipart bodies. The ticket names this capability beside the rows, so the
  registry subset test pins it as an extra capability (permission
  `upload.create`, tier W).
- **The fetch is the outbound-request policy's** (`docs/outbound-requests.md`):
  https only, public addresses only, every redirect (at most 3) checked again,
  an `audio/*` content type, at most 200 MiB (the audio upload limit) streamed
  under the cap, one 120 second deadline. No request header is sent. The
  bytes then go through `UploadsService.upload()`, so size, type and extension
  are validated, and a song's tags and cover are read, exactly as for a file
  the operator sends.
- **No media asset, no analysis scheduling.** An upload only stores the file
  (S3) and answers `{key, url, bucket, contentType, sizeBytes, metadata?}`; the
  asset is created by the create that follows (`song_create` or the instant and
  background creates) and analysis follows from the asset. The import does the
  same: use the answer's `url` there.
- **The address is never logged or echoed; only its file name is kept.** The
  stored object key carries the sanitised last path segment as the file name of
  a sent file does, nothing else of the address. The audit target is
  `import-<kind>`; the dry run and the answer carry no address; a refusal is
  the policy's plain message (400 as `invalid`; 502 and 504 and a failed store
  as `unavailable`). The idempotency record keeps a hash of the arguments.
- **Metric:** `alcantara_outbound_fetch_total{path="media_import",result}`,
  the policy's counter (all series start at zero); no new metric.

## Flight sequences, the rundown (#215)

File: `backend/src/mcp/capabilities/flight.ts` (`FlightMcpTools`, listed in
`ProgramModule` beside `ProgramMcpTools`), the program routes under
`/program/:programId/flight`: 14 rows of appendix A (2 R, 5 W, 6 A, 1 D), each
calling the `FlightService` method its controller calls, in process. The
closing test is `flight-appendix.spec.ts`: it reads those rows from
`appendix-a.tsv` and asserts a capability with that name, permission and tier
for each, and that the permission is the one the controller handler requires.
Sequence names, cues (`items`) and the filler warnings (which carry song
titles) are user text and sit under `untrusted`.

### Read capabilities

| Capability | Permission | Answers like |
|---|---|---|
| `program_list_flight_sequences_by_id` | `flight.read` | `GET /program/:programId/flight` (every sequence with its cues, schedule, publication state, revision and `isRunning`) |
| `program_preflight_flight_sequence_by_id` | `flight.read` | `GET /program/:programId/flight/:sequenceId/preflight` (`ready` and the `issues` found; a sequence with no scheduled start is `invalid`) |

### Write capabilities (`flight.manage`)

Arguments mirror the controller's body in snake_case (`scheduled_at`,
`sequence_id`, `program_id`); the cues and the nested `rules` keep the console's
own keys (`labelId`, `clockOffsetSeconds`, `artistSeparation`), because the
service reads them as they are. The service validates every cue, the schedule
and the revision; its refusals come back as the closed MCP codes (400 `invalid`,
404 `not_found`, 409 `conflict`). `items` is bounded at 500 cues by the
capability (a clocked log holds at most 120). `revision` is required on
`generate`, `fill` and `publish` (the service refuses any other value) and
optional on `update` (a clocked log needs it).

| Capability | Plan (dry run) |
|---|---|
| `program_create_flight_sequence_by_id` | Creates a draft; it is not active and does not air until activated and started (or published and its start arrives). Recoverable: delete it. |
| `program_update_flight_sequence_by_id` | Lists what changes, from the sequence as it is now. On a running sequence the dry run reports `onAir: true` (later cues change at once; the console refuses schedule and loop changes and edits of the cue on air or already played). The previous values are not kept. |
| `program_generate_tagged_log` | A proposal: returns the cues and saves nothing (save them with update). Refused by the console unless the log is an unaired, unpublished draft of a program with a radio leg. |
| `program_fill_rundown` | The same for the gaps of a rundown; answers cues and warnings. |
| `program_publish_flight_sequence_by_id` | Publishes a clocked log: the console then starts it by itself at its scheduled time, with nobody present, and its start cannot move. There is no unpublish (the way back is a delete, refused while it is queued, or editing its cues). Not recoverable. |

### On-air capabilities (`flight.operate`)

All six are A rows on a program (`program_id`), confirmed by the program's live
stamp with the flight position appended:
`scene:<id|null> fade:<0|1> song:<0|1> queue:<n> flight:<active id|none> running:<0|1> cue:<active cue id|none>`.
A plan made before the program went on or off air, the flight started or
stopped, or the log moved to another cue is refused as `confirm_mismatch`; for
`go` that includes the log advancing on its own timer.

| Capability | The console does |
|---|---|
| `program_activate_flight_sequence_by_id` | Makes the sequence active. A running flight stops and the song playing is cut (a sequence that is not clocked always does this, even when nothing runs); nothing starts yet. A clocked log must be published and pass preflight. |
| `program_deactivate_flight_sequence_by_id` | Stops the flight, cuts the song and clears the active sequence. |
| `program_start_flight_by_id` | Starts the active sequence from cue 1 (a running one stops, cutting the song, and starts over); its cues then act on air by themselves. |
| `program_stop_flight_by_id` | Stops the cues and cuts the song, turning the rotation to manual; the sequence stays active. |
| `program_go_flight_by_id` | Runs the next cue at once; with no flight running it starts the active sequence. A clocked log cannot advance before its scheduled start. |
| `program_reset_flight_by_id` | Stops, cuts the song, clears the position; restarts from cue 1 if it was running. |

The answers are the console's (`{activeSequenceId}` or `{ok: true}`).

### Step 0 of the D row: what the console does today

| Capability | The console today | The capability |
|---|---|---|
| `program_delete_flight_sequence_by_id` | Deletes the sequence whatever its state. A running sequence is stopped first (the song playing is cut and the rotation turns manual); if it is the active sequence the program's active pointer is cleared; a published clocked log still waiting for its start is dropped and never airs. It never looks at the as-run state. | `on_air` while the sequence is running, is the program's active sequence, or is published and queued to start (published, never started, scheduled start not more than 5 s in the past, which is the console's own start window). Checked again at run time. Not recoverable: the cues, their order, the schedule and the published state are gone, with no copy and no unpublish; the dry run lists the sequence and program and says to read it first and recreate it by hand. A sequence that is a draft, already aired, or whose start was missed is deleted after the confirm. Confirm target `{id: "<program>/<sequence>", name: <sequence name>}`. |

Metrics: the area adds none; calls count under the executor's
`alcantara_mcp_requests_total{tool,tier,result}`. `generate`, `fill` and
`publish` keep recording the console's own `radio log` results, since they call
the same service methods.
