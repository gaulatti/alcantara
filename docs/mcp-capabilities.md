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
| `media_list_artist_labels` | `media.read` | `GET /artist-labels` |
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
`url` (at most 2000 characters) and `kind` (`instant`, `background`, `song`,
`artwork` or `stinger`: the five kinds the console's upload routes take; #226
added the last two).

- **It covers the five `upload_*` rows.** Appendix A's `upload_instant`,
  `upload_background`, `upload_song`, `upload_artwork` and `upload_stinger` are
  multipart routes that an MCP client cannot use; they are marked
  `covered by import_media_from_url` in the tsv and are not capabilities of
  their own. The console has no import route: its uploads are multipart bodies.
  The ticket names this capability beside the rows, so the registry subset test
  pins it as an extra capability (permission `upload.create`, tier W).
- **The fetch is the outbound-request policy's** (`docs/outbound-requests.md`):
  https only, public addresses only, every redirect (at most 3) checked again,
  the content type and byte cap of the kind, streamed under the cap, one 120
  second deadline. No request header is sent. Per kind: `instant`, `background`
  and `song` take an `audio/*` type (or `application/ogg`), at most 200 MiB;
  `artwork` an avif, gif, jpeg, png or webp image, at most 10 MiB; `stinger`
  `video/webm`, at most 50 MiB (the limits of `UploadsService`'s upload
  routes). The bytes then go through `UploadsService.upload()`, so size, type
  and extension are validated as for a file the operator sends, and a song's
  tags and cover are read. An address whose answer is of another kind's type
  (an image for a song, audio for artwork) is refused before the body is read.
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
| `program_preflight_flight_sequence_by_id` | `flight.read` | `GET /program/:programId/flight/:sequenceId/preflight` (`ready`, the `issues` found, and `warnings` that never block a start, such as a song of unknown duration, under `untrusted` like every `warnings` field; `issueEvents` and `warningEvents` give each line's event as `{item, reason}` with its `name` under `untrusted`; a sequence with no scheduled start is `invalid`) |
| `program_list_recipes_by_id` | `flight.read` | `GET /program/:programId/recipes` (each rundown recipe with its scenes, transition, hold, enabled steps and revision; gaulatti/alcantara#424) |
| `program_expand_recipe_by_id` | `flight.read` | `POST /program/:programId/recipes/:recipeId/expand` (the cues one use would add for a song, and its issues; writes nothing) |

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
| `program_create_flight_sequence_by_id` | Creates a draft; it is not active and does not air until activated and started (or published and its start arrives). Recoverable: delete it. A clocked log with a fixed start outside its window is refused, and the dry run says `REFUSED (invalid)` (#788). |
| `program_update_flight_sequence_by_id` | Lists what changes, from the sequence as it is now. On a running sequence the dry run reports `onAir: true` (later cues change at once; the console refuses schedule and loop changes and edits of the cue on air or already played). The previous values are not kept. A clocked log with a fixed start outside its window is refused, and the dry run says `REFUSED (invalid)` (#788). |
| `program_generate_tagged_log` | A proposal: returns the cues and saves nothing (save them with update). Refused by the console unless the log is an unaired, unpublished draft of a program with a radio leg. |
| `program_fill_rundown` | The same for the gaps of a rundown; answers cues and warnings. |
| `program_create_recipe_by_id` | Creates a rundown recipe on a program with a television leg. Nothing airs until a use of it is added to a rundown that runs. Recoverable: change it. |
| `program_update_recipe_by_id` | Changes a recipe with the revision read (stale is a conflict), then rebuilds its uses not yet on air in the program's operator rundowns; cues on air or played are never touched. The answer counts the rebuilt uses. |
| `program_add_recipe_use_by_id` | Adds one use of a recipe for a song (the song recipe: bumper, hold, song, slideshow for the song, back) to an operator rundown at a position or at the end, through the rundown's normal update. Refused (`on_air`) at or before the cue on air. Recoverable: remove the cues in the rundown. |
| `program_delete_recipe_by_id` | Tier D: deletes a recipe read at `revision` (stale is a conflict). The dry run lists its uses per rundown. Refused `on_air` while a use is in a running rundown; with uses left it is refused unless `remove_uses` is true, which removes those use cues from their rundowns first. Not recoverable (gaulatti/alcantara#465). |
| `program_publish_flight_sequence_by_id` | Publishes a clocked log: the console then starts it by itself at its scheduled time, with nobody present, and its start cannot move. There is no unpublish (the way back is a delete, refused while it is queued, or editing its cues). Not recoverable. A log whose content overruns a fixed start is refused with on_air unless `accept_overrun` is true, as the desk asks "Publish anyway"; the dry run gives `overrunMs` and the cut length (#788). |

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
| `program_go_flight_by_id` | Runs the next cue at once; with no flight running it starts the active sequence. A clocked log cannot advance before its scheduled start. Refused with on_air, dry run included, only while Palazzo freshly reports the playout of a radio-only program down (the take's rule, D4); a stale or missing report and a simulcast program go through, counted (#788). |
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

## Instants and stingers (gaulatti/alcantara#217)

Files: `backend/src/mcp/capabilities/instants.ts` (`InstantsMcpTools`, registered
in `InstantsModule`) and `backend/src/mcp/capabilities/stingers.ts`
(`StingersMcpTools`, registered in `StingersModule`). Ten appendix A rows: two
R, four W, two A and two D. All are `firstClass: false`, call the service the
console's controller calls in process (`ProgramService` for instants,
`StingersService` for stingers) and answer what the controller answers, with
user text under `untrusted`. The program and radio rows that name instants and
stingers (`program_take_program_scene_instant_by_id`,
`program_add_stinger_to_program`, `radio_play_instant` and the like) belong to
the program and radio areas, not to this one.

### Reads

- `instant_list_instants` (`instant.read`): `program_id` (optional; the console's
  `programId` query, default `main`) selects which song each instant introduces
  (`assignedSongId`). The answer is the console's list: every instant in order
  with `availableForSongIntro`. The name (and, as untrusted, the audio address)
  sit under `untrusted`.
- `stinger_list_stingers` (`stinger.read`): no arguments; every stinger, newest
  change first. Name and video address sit under `untrusted`.
- No answer carries a credential: an answer that holds a signed link or a
  credential field is withheld (`unavailable`), the same tripwire as every other
  capability, tested with a planted secret.

### Writes and operations

The service of every row is the controller's; an argument is the controller's
field in snake case, `*_id` named after the path parameter. Answers equal the
controller's answer for the same input (one set of fake services behind both),
except that user text is under `untrusted`. A service refusal is reported as the
closed MCP code (400 as `invalid`, 404 as `not_found`).

| Capability | Tier | Permission | Arguments | Answer and notes |
|---|---|---|---|---|
| `instant_create_instant` | W | `instant.manage` | `name`, `audio_url`, `volume`, `enabled` | The created instant. The service clamps `volume` to 0..1 (the console accepts any finite number, so does this); the instant goes to the end of the list and gets its media asset. |
| `instant_update_instant` | W | `instant.manage` | `instant_id`, `name`, `audio_url`, `volume`, `enabled` | The instant. A field left out stays. The dry run says where the instant is used (scene backgrounds, bumper rotations) and sets `onAir` while it is playing, named by a scene on air or staged, or in a rotation with bumpers on. |
| `instant_delete_instant` | D | `instant.manage` | `instant_id` | `{deletedInstantId}`. See the D table. |
| `instant_play_instant` | A | `instant.operate` | `instant_id`, `program_id` (default `main`) | `{ok: true}`. The console's `programId` query or body. Plays once, now, over what is playing. Confirm target: `{id: instant id, name: "<instant name> on <program> (enabled|disabled; <live stamp>)"}`, so a plan made before the instant was disabled or the program changed state is refused as `confirm_mismatch`. |
| `instant_stop_all_instants` | A | `instant.operate` | `program_id` (default `main`) | `{ok: true}`. Confirm target: `{id: program, name: live stamp}`. |
| `stinger_create_stinger` | W | `stinger.manage` | `name`, `video_url`, `cut_point_ms`, `enabled` | The created stinger (cut point default 1000 ms, enabled default true). `cut_point_ms` is an integer of at least 0: the column is an integer and the console sends any number to the database, which fails for a fraction. |
| `stinger_update_stinger` | W | `stinger.manage` | `stinger_id`, `name`, `video_url`, `cut_point_ms`, `enabled` | The stinger. A field left out stays. `onAir` in the dry run while a program that uses it has a scene or fade to black on air (its next scene change shows the change). |
| `stinger_delete_stinger` | D | `stinger.manage` | `stinger_id` | `{deletedStingerId}`. See the D table. |

- **Program defaults.** `instant_play_instant` and `instant_stop_all_instants`
  take `program_id` with default `main` (the console's default when no program is
  sent), so the action executor always spaces on-air runs by a program. The
  capability loads the program's live state for the dry run and the confirm
  stamp, so an unknown program is `not_found` here where the console broadcasts
  to a program nobody listens to.
- **Instant text.** `audioUrl` is user text and moves under `untrusted` with the
  name; an answer whose address is a signed link is withheld (`unavailable`) like
  everywhere else, after the write has happened.
- **Rows the program and radio areas own.** Taking and stopping a scene instant
  (`program_take_program_scene_instant_by_id`,
  `program_stop_program_scene_instant_by_id`), adding and removing a stinger on a
  program (`program_add_stinger_to_program`,
  `program_remove_stinger_from_program`) and `radio_play_instant` /
  `radio_stop_all_instants` are capabilities of #216 and #214's areas; the
  stinger upload is the plain W row `upload_stinger`, left to #226.

### Step 0 of the D rows: what the console does today

| Capability | The console today | The capability |
|---|---|---|
| `instant_delete_instant` | Checks the instant exists, answers 400 when it is a song's intro (any program), then in one transaction deletes the instant and its media asset and renumbers the later instants. It never looks at what is playing, named by a scene or in a bumper rotation. | `on_air` while a program is playing it as its scene background, while a scene on air or staged names it as `sceneInstant.instantId` in its settings, or while a program with bumpers on lists it in `bumperInstantIds` (the bumper timer would then find no audio and skip silently). The song intro refusal stays the console's (`invalid`) and the dry run says so. The dry run lists the programs whose scenes name it and whose rotations list it (off air or with bumpers off they do not refuse), that the media asset and the place in the list are lost, and that none of it can be recovered (a new instant gets a new id, so scene settings and rotations that name the old id must be edited by hand). The audio file stays in storage. |
| `stinger_delete_stinger` | Checks the stinger exists, then in one transaction deletes it and its media asset; its program assignments go by cascade. It never looks at what is on air. | `on_air` while a program that uses it has a scene or fade to black on air, because that program's scene changes play its stingers (the condition `program_remove_stinger_from_program` refuses on). The dry run lists the programs it is taken off and that the name, the cut point and each program's place for it are lost, not recoverable (a new stinger gets a new id and is added to each program again). The video file stays in storage. |

Both refusals are checked again when the action runs, so a plan made while the
target was idle cannot delete a live one. A target that a program uses while
that program is off air is not an `on_air` case: the dry run lists it as lost
and the capability proceeds after the confirm.

### Tests

`instants-stingers-reads.spec.ts` and `instants-stingers-writes.spec.ts` pin the
ten rows against `appendix-a.tsv` (name, permission, tier, the controller's own
permission, dry run and confirm target presence), compare each answer with the
real controller's over the same fake service, and plant a signed link or a
credential field in a service answer to prove it is withheld.
`instants-stingers-destructive.spec.ts` is the Step 0 table as tests: each
refusal (`on_air` from both the dry run and the run, the service not called),
the idle run and the unrecoverable dry run. `instants-stingers-registry.spec.ts`
runs the providers through the registry's real call path (visibility by
permission, dry run, confirmation, idempotency, re-authorization and the
default program). No metric is added: the executor's counters cover every
capability.

## Broadcast, filler, recording, radio, preferences, external sources and guests (#219)

Files: `backend/src/mcp/capabilities/{destinations,filler,recording,radio,preferences,external-sources,webrtc}.ts`,
each registered in the module of the services it calls. The 60 rows of
appendix A that are not excluded and not another ticket's:

| Area | R | W | A | D | Total |
|---|---|---|---|---|---|
| broadcast destinations (`destination_*`) | 3 | 5 | 3 | 0 | 11 |
| filler (`filler_*`) | 1 | 3 | 0 | 0 | 4 |
| recording and tape (`recording_*`) | 2 | 0 | 4 | 0 | 6 |
| radio (`radio_*`: settings, Palazzo, recovery, now-playing, manual song and instant) | 7 | 3 | 6 | 0 | 16 |
| operator preferences (`preference_*`) | 2 | 3 | 0 | 3 | 8 |
| external sources (`external_source_*`) | 2 | 0 | 4 | 1 | 7 |
| guests (`webrtc_*`) | 2 | 0 | 3 | 3 | 8 |
| **Total** | **19** | **14** | **20** | **7** | **60** |

`backend/src/mcp/capabilities/appendix-a-broadcast.spec.ts` reads these rows
from `appendix-a.tsv` and asserts, for each, the capability's name, permission
(and that it is the controller handler's own), tier, a dry run for every W, A
and D, and a confirm target for every A and D.

**Not capabilities.** Appendix A marks thirteen rows excluded (capability
column `—`) because they return or produce a credential:
`POST /auth/realtime-ticket`, `POST /radio/:programId/monitor-ticket`,
`POST /program/:programId/recording/download-ticket`,
`POST /external-sources/:id/credentials/rotate`, `POST /webrtc/operator-token`,
`POST /webrtc/host-mic-token`,
`POST /webrtc/desktop-program-feed-token`,
`POST /webrtc/invitations/:id/screening-token`,
`POST /broadcast/destinations/:destinationId/ingest` (a destination's ingest key),
`POST /broadcast/destinations` (adds one with its stream key) and
`PUT /broadcast/destinations/:destinationId/key` (replaces the key),
and the two routes whose whole product is a guest link,
`POST /webrtc/invitations` (create) and
`POST /webrtc/invitations/:id/replace` (replace; it also disconnects the
guest). A guest link is created and replaced in the console only, and a private
talk with a waiting guest is the operator's own microphone. The four
`radio_similarity_*` rows belong to #218. `auth_get_me` is not in these areas.

### What differs from the console's answer

- **No credential is ever returned.** `external_source_create` answers
  without the credential a push (RTMP, WHIP) source is issued: the answer has
  `credentialIssued: true` and a note, and the credential is read after
  rotating it in the console. The answer tripwire still withholds any answer
  that carries a credential field or a signed link as `unavailable`.
- **Now-playing consumer headers** can carry an API key, so
  `radio_list_now_playing_consumers` and
  `radio_replace_now_playing_consumers` answer each consumer with
  `headerNames` (under `untrusted`) and never the values. To replace the list
  without retyping a header value, set `keep_stored_headers` on the consumer:
  it keeps the stored headers of the stored consumer of the same name
  (`invalid` when there is none); headers given beside it win.
- Destination catalog rows carry the Secrets Manager reference of the stream
  key (`secretId`, `secretVersionId`), as the console's management endpoint
  does (`broadcast.manage`), never the key.
- Added to the untrusted keys: `displayName`, `url`, `listenerUrl`,
  `palazzoUrl`, `text`, `payload`, `headerNames`.

### Arguments the console sends differently

- `destination_start`, `destination_reload` and `destination_stop` take
  `command_id` (the console's `commandId`, the executor's replay key) and
  send `confirmed: true` themselves, because the framework's `confirm` string
  has matched by then. `stop` takes no destinations. The caller is the
  `actorSubject`. The confirm name is where the executor is
  (`requested=… actual=… transition=…`, or `executor-unavailable`).
- `recording_start`, `recording_stop`, `recording_tape_start` and
  `recording_tape_stop` take `command_key` (the console's `Idempotency-Key`
  header, validated by the same function). The confirm name is the recording
  state.
- `radio_update_settings` repeats the controller's three steps (read the
  previous settings, update, reload the similarity settings when a similarity
  field was given, reconnect telemetry when the Palazzo address or `enabled`
  changed). Its dry run is live for every field except `listener_url`.
- `radio_start_recovery` and `radio_stop_recovery` confirm against Palazzo's
  automation state and refuse what the desk's recovery buttons disable (#788):
  Start while Palazzo reports its playout down, with no prepared playlist, when
  Palazzo is not connected or while a session runs; Stop when none runs. Their
  dry run says `REFUSED (on_air)` first; the manual song and instant routes
  (`radio_play_song`, `radio_stop_song`, `radio_play_instant`,
  `radio_stop_all_instants`) confirm against the program's live stamp, like
  the program actions. `radio_play_instant` accepts `instant_id` as the
  console sends it; the route does not use it.
- `radio_play_song` and `program_update_program_audio_bus_by_id` go through
  the same engine check as their routes (#609): while a radio-only program's
  engine is off, a manual song, or an audio-bus write that would start a song,
  is refused with `conflict` before anything plays or is saved.
- `webrtc_update_return` sets every field of the return feed: a field not
  given goes to its default (program, master, 1, not muted, 0 ms), exactly as
  the console's route does. The dry run shows the resulting values.
- `webrtc_control_participant` takes a flat body (`type`, then `device`,
  `enabled`, `cue` or `text` as the type needs); the service validates it.
- The preference capabilities act as the caller (subject and canonical
  principal from Pompeii) and read shared layouts with the caller's
  permissions and the application's team, as the console's guard builds them.
  A caller never reaches another operator's profile.

### Step 0 of every D row: what the console does today

| Capability | The console today | The capability |
|---|---|---|
| `external_source_revoke` | Revokes every credential, marks the source revoked and unavailable and clears its ingress and participant, whatever is on air. A scene whose `externalSourceId` points at it keeps pointing at it and shows nothing. There is no restore. | `on_air` while a scene that points at the source is on air or staged on any program. Not recoverable: a new source must be created and its scenes pointed at it. The dry run lists the programs that have such a scene. |
| `webrtc_revoke_invitation` | Revokes the invitation (its link dies, its slot is freed) and removes the guest from the room if connected, whatever is on air. | `on_air` while the guest is connected (status `active`) and the program has a scene or fade to black on air (the guest may be in the picture; which scene shows which guest is not recorded). Not recoverable: a new invitation needs a new link, made in the console. |
| `webrtc_decline_guest` | Declines a waiting guest: revokes the invitation and frees the slot. Offered only for a guest who is waiting. | `on_air` refusal for a guest who is not waiting. Not recoverable. |
| `webrtc_remove_participant` | Disconnects the guest at once and clears their session; the invitation stays valid, so the guest can rejoin with the same link. Never looks at what is on air. | `on_air` while the guest is connected and the program is on air. Recoverable (rejoin). |
| `preference_retire` | Marks the shared layout retired and bumps its version; it stops being listed and loadable. Copies operators already loaded are plain profile copies and stay. A layout is not an on-air object. | Never `on_air`. Recoverable: publishing the same name again clears the retirement. `not_found` for a layout that is not there. |
| `preference_reset_class` | Deletes the caller's saved profile for the class (the default applies again). Only the caller's own row. | Never `on_air`. The dry run says the version that is lost; not recoverable unless nothing was saved. |
| `preference_reset_all` | Deletes every saved profile of the caller. | Never `on_air`. The dry run lists the version of each class; not recoverable unless nothing was saved. |

A guest who is not connected, a program off air or a source no scene points
at is not an `on_air` case: the dry run lists what is lost and the capability
proceeds after the confirm, as the console does.

### Rows worth knowing about

- `destination_retire_destination`, `destination_restore_destination` and
  the other catalog rows are W: a running broadcast keeps the immutable
  selection it started with, so none of them changes what is on air.
- `external_source_redirect` is an A row although it changes nothing (it
  resolves the host name and answers a fingerprint).
- `filler_prepare_television` and `filler_prepare_radio` write the pending
  (next session) version only; the version in session changes at a broadcast
  start or a recovery start.
- Metrics: the area adds no metric. The executor counts every call under
  `alcantara_mcp_requests_total{tool,tier,result}`.

### Remove playlist leaves (`program_remove_program_song_leaves_by_id`, #327)

File: `backend/src/mcp/capabilities/song-leaves.ts`; the work is
`ProgramService.removeProgramSongLeaves` and `SongExecutionEngine.removeSongLeaves`.
An A capability with `program.operate`, taking `program_id`, `leaf_ids` (1 to 200),
and optional `keep_rotation` and `dry_run`. It has no route of its own: the console
removes a leaf by sending the whole edited playlist, and
`program_update_program_audio_bus_by_id` does the same with a whole `songSequence`,
cursor (`activeItemId`, `startedAt`) included, and must send the `sequence_version` that
`get_queue` gave. The cursor changes with every song and is not part of the version, so a
whole-playlist write still races the rotation's cursor.

- **What it writes.** Under the engine's queue-mutation lock it reads the row, takes the
  sequence the engine holds when that differs from the stored one only by the cursor
  (so the cursor is the live one), removes exactly those leaves at any depth, keeps every
  other field as stored, filters the Play Next queue with `filterProgramSongQueueForSequence`
  and stores both with one compare-and-swap on the row's `updatedAt`. A row that moved is
  re-read and the removal retried (4 attempts, then a conflict and nothing written).
  It then broadcasts the same `audio_bus_update` as the normal path. A song that ends
  between the read and the write is not undone: the engine's in-memory cursor is kept.
- **Refusals.** An unknown leaf id (nothing changes); a program with no playlist; the
  leaf on air, unless `keep_rotation` is set, which keeps the rotation going: the leaf after
  the removed one plays next (a refusal if no other leaf is left). The engine reads the cursor
  as the song on air or last aired, so it moves back to the nearest kept leaf before the removed
  one (wrapping in a loop); a cursor cued after a Stop or an end (`cuedItemId`, not aired yet),
  or one with nothing kept before it, moves forward and stays cued (walk part 5).
- **Dry run.** Returns the leaves that would be removed (id, song id, artist, title,
  high rotation) and the leaf count before and after, and writes nothing.
- **Metrics.** None new: it does not use the engine's best-effort cursor write, so
  its cursor-write result counts are unchanged; a retry exhausted is a visible
  conflict error, not a metric.

## The rows no ticket owned (#226)

Appendix A is 167 rows: 154 are capabilities, 6 are `covered by` another tool
(`whoami` or `import_media_from_url`; 160 capability rows in all) and 7 are
exclusions (they return or produce a credential). Ticket #224 adds the access
rows below: 11 more, for 178 in all (163 capabilities, 7 `covered by`, 8
exclusions; 170 capability and covered rows).

| Row | Outcome | Why |
|---|---|---|
| `auth_get_me` | covered by `whoami` | Same permission (`access`), same tier (R), no service behind either: both answer the caller's own identity from the verified token. `whoami` carries subject, principal id, client and the sorted permissions; the console's route also returns the Pompeii role names and team id, which the MCP principal does not hold. |
| `as-run_export` | registered capability (`backend/src/mcp/capabilities/as-run.ts`) | Not covered by `get_as_run`: that tool lists rows as data through `AsRunService.listRecords` in a window of at most `asRunWindowDays`; the row is the download, `AsRunService.export`, a CSV of the log or the SoundExchange report of use over any window. Same permission (`radio.read`) and tier (R). Args `program_id`, `from`, `to` (ISO 8601, each optional: an omitted `to` is open, and an omitted `from` is 31 days before `to` or now, gaulatti/alcantara#237), `format` (`csv` or `soundexchange`), `inferred`; the file text is in `untrusted.csv` with `program_id` and `format`. **Capped at 5,000 rows** (`AS_RUN_EXPORT_MAX_ROWS`): `AsRunService.countExportRows` counts the window first with the export's filters (every record for csv, the ended records of the `inferred` filter for soundexchange), and a larger window is refused as `invalid` with its row count and a request to narrow `from` and `to`. |
| `radio_get_palazzo_status` | capability (already registered by #219) | Mirrors the controller: `PalazzoRadioTelemetryService.getStatus`, `radio.read`, R, `firstClass: false`. |
| `radio_get_output_confidence` | capability (already registered by #219) | Mirrors the controller: program check, then `RadioOutputConfidenceService.get`; `radio.read`, R. |
| `upload_artwork`, `upload_stinger` | covered by `import_media_from_url` | The import now takes both kinds with the upload routes' type and size limits. |

The exclusions are unchanged. The console's as-run download stays uncapped; only the MCP capability refuses a window over 5,000 rows. The area adds no metric.

## Access (gaulatti/alcantara#224)

File: `backend/src/mcp/capabilities/access.ts` (`AccessMcpTools`), registered in
`AccessModule` beside the `/access` controller. Each capability forwards the
caller's own `Authorization` header to Pompeii's `ApplicationAccessService`
through `AccessService` with `via_client: mcp`, so Pompeii's audit shows the
change came from an MCP client. Pompeii makes every decision; Alcantara adds
no check but the `alcantara:access` permission every signed-in caller holds, and
the registry asks Pompeii again before each A and D action (`reauthorize`), so a
revoked session or a removed manage key is refused on the next call.

| Capability | Tier | Route it mirrors | Notes |
|---|---|---|---|
| `list_my_tokens` | R | `GET /access/tokens` | id, name, permissions, created and last used (when and in which application). Never a value or a display prefix. |
| `revoke_my_token` | W | `DELETE /access/tokens/:id` | Dry run, no confirm. Revokes the caller's own token only (Pompeii enforces it). |
| `get_token_switch` | R | `GET /access/token-switch` | |
| `set_token_switch` | A | `PUT /access/token-switch` | Needs `alcantara:access:manage` in Pompeii. Confirm string `token switch on to off` (the switch as read now), so a plan made before someone else flipped it is refused as `confirm_mismatch`. |
| `list_access_roles` | R | `GET /access/roles` | |
| `list_grants` | R | `GET /access/grants` | |
| `grant_role` | D | `POST /access/grants` | Args `user_id`, `role_id`. Confirm names the role and user ids. Pompeii bounds it: the caller must hold every permission the role carries. |
| `revoke_role` | D | `DELETE /access/grants/:id` | Arg `grant_id` (from `list_grants`); a grant that is not listed is `not_found`. |
| `list_access_history` | R | `GET /access/history` | Args `limit` (1 to 200) and `before` (RFC 3339). |

`POST /access/tokens` is **excluded** (it returns a token value), and
`GET /access/my-permissions` is **covered by `whoami`** (the caller's own
permissions). There is no capability that creates a token, and none returns a
token value or `display_prefix`: `list_my_tokens` lists tokens through an
explicit field list, and `display_prefix` joins the keys the answer tripwire
(`assertNoCredential`) refuses, so an answer that ever carried one would be
withheld. What people typed (`name`, `user_email`, `actor_email`, `target`,
`role_name`) travels under `untrusted`.

Pompeii's errors become the closed MCP codes without its message:
`UNAUTHENTICATED` and `PERMISSION_DENIED` are `forbidden` (a personal access
token is refused as the person: sign in to manage access), `INVALID_ARGUMENT` is
`invalid`, `FAILED_PRECONDITION` (the token switch is off) is `conflict`,
`NOT_FOUND` is `not_found`, and anything else, or no service credential, is
`unavailable`. The capabilities need the connection's own credential, so an
MCP client signed in with a personal access token gets `forbidden` from Pompeii;
use an OAuth session.

Tests: `access.registry.spec.ts` runs the nine on the registry's real call path
over the real `AccessService` (tiers, confirm, re-authorization before every A
and D, the error mapping, and a check over every answer that no token value or
display prefix is returned). `mcp.registry.appendix.spec.ts` pins the new totals.
Metrics: `alcantara_access_requests_total{route,result}` and
`alcantara_access_request_duration_seconds{route}` count the Pompeii calls
([Access](access-api.md)); the executor counts each tool call as usual.

## Tier W and the actor (#213)

The action executor wraps the run of every W, A and D action in the
`MCP_ATTRIBUTION` provider (a dry run and a replay are not wrapped), so the actor
(principal, `via: 'mcp'`, client name) is readable at command time. Wrapping
records nothing by itself: a capability is attributed only where the engine
reads `ActorContext` when the command arrives, and then carries the value with
the event or the pending song, so a later timer never reads it. Today those
readers are the song engine's stop, manual pick, enqueue, reorder and remove
(`backend/src/radio/song-execution.engine.ts`), which write the as-run `ended`
and `started` columns and the `song_queue_update`, `song_off_air` and
`song_playback_active` events. Automatic transitions keep all three fields null.

Every W capability, and whether it changes what is on air or queued:

- **Queue**: changes the Play Next queue. Its actor is recorded.
- **Live output**: its own `onAir` declaration (or its plan) says viewers or
  listeners see the change at once, but the service writes no as-run row and
  emits no engine operator event, so there is no record to attribute. The MCP
  audit line (`McpAudit`, identity and tool) is the only trace; giving these a
  record is a new mechanism and is not part of #213.
- **No**: library, catalog or console-profile data, a proposal, or a value read
  by a later (A-tier or automatic) start.

| Capability | Defined at | Changes on air or queued | Actor recorded | Why |
|---|---|---|---|---|
| `destination_reorder_destinations` | `backend/src/mcp/capabilities/destinations.ts:134` | No | - | Catalog order only; a running stream keeps its destinations. |
| `destination_rename_destination` | `backend/src/mcp/capabilities/destinations.ts:155` | No | - | Display name only; a running stream keeps the selection it started with. |
| `destination_retire_destination` | `backend/src/mcp/capabilities/destinations.ts:` | No | - | Blocks future selection; a stream already out is not touched. A key this backend wrote is scheduled for deletion after 30 days (#384). |
| `destination_restore_destination` | `backend/src/mcp/capabilities/destinations.ts:` | No | - | Re-enables selection for a later start. Cancels the key's scheduled deletion first, and is refused (503) if that fails (#384). |
| `destination_test_destination` | `backend/src/mcp/capabilities/destinations.ts:` | No | - | Opens a connection to the destination's ingest with the stored key; no media is sent (#384). |
| `filler_prepare_television` | `backend/src/mcp/capabilities/filler.ts:36` | No | - | Its description: it does not change what is on air; the version is pending for the next session. |
| `filler_prepare_radio` | `backend/src/mcp/capabilities/filler.ts:60` | No | - | Same: pending for the next recovery start, a running session keeps its version. |
| `instant_create_instant` | `backend/src/mcp/capabilities/instants.ts:138` | No | - | A new library row; nothing names it yet. |
| `instant_update_instant` | `backend/src/mcp/capabilities/instants.ts:167` | Live output | Recorded: an `OperatorChangeRecord` with no program (see "Operator change records for library changes" below) | Declares `onAir` while it plays as a scene background, is named by a scene on air or staged, or is in the rotation of a program with bumpers on (instants.ts:197). |
| `layout_create` | `backend/src/mcp/capabilities/layouts.ts:84` | No | - | A new library row. |
| `layout_update` | `backend/src/mcp/capabilities/layouts.ts:109` | Live output | Recorded: an `OperatorChangeRecord` of who made the change, the changed field names and, for names, ids and flags, the value before and after (#236); free text, JSON, cues and template addresses are named, never valued | Declares `onAir` while a scene of the layout is on air (layouts.ts:131). |
| `media_asset_create_background_audio` | `backend/src/mcp/capabilities/media-assets.ts:224` | No | - | A new library asset. |
| `media_asset_replace_asset_labels` | `backend/src/mcp/capabilities/media-assets.ts:254` | No | - | Label membership of one asset; the spec declares no on-air effect. |
| `media_set_artist_label` | `backend/src/mcp/capabilities/artist-labels.ts:42` | No | - | Attaches a media label to an artist; the artist bumper and the song recipe read it when they next build, nothing on air changes. |
| `media_asset_create_label` | `backend/src/mcp/capabilities/media-assets.ts:279` | No | - | A new, empty label. |
| `media_asset_update_label` | `backend/src/mcp/capabilities/media-assets.ts:301` | Live output | Recorded: an `OperatorChangeRecord` with no program (see "Operator change records for library changes" below) | Declares `onAir` while a program that reads the label is on air (media-assets.ts:322). |
| `media_asset_replace_label_assets` | `backend/src/mcp/capabilities/media-assets.ts:332` | Live output | Recorded: an `OperatorChangeRecord` with no program (see "Operator change records for library changes" below) | Declares `onAir` while a program that reads the label is on air (media-assets.ts:350). |
| `media_group_create` | `backend/src/mcp/capabilities/media-groups.ts:88` | No | - | A new group; nothing assigns it. |
| `media_group_update` | `backend/src/mcp/capabilities/media-groups.ts:114` | Live output | Recorded: an `OperatorChangeRecord` with no program (see "Operator change records for library changes" below) | Changes the media a live page may read; the spec declares no `onAir` flag (judgement: treated as live output, not as queue). |
| `media_create` | `backend/src/mcp/capabilities/media.ts:88` | No | - | A new image row. |
| `media_update` | `backend/src/mcp/capabilities/media.ts:106` | Live output | Recorded: an `OperatorChangeRecord` with no program (see "Operator change records for library changes" below) | Declares `onAir` while a group or scene on air reads the image (media.ts:131). |
| `preference_publish` | `backend/src/mcp/capabilities/preferences.ts:106` | No | - | A shared console layout for operators; its plan says nothing on air changes. |
| `preference_load` | `backend/src/mcp/capabilities/preferences.ts:158` | No | - | Copies a layout into the caller's own console profile. |
| `preference_save` | `backend/src/mcp/capabilities/preferences.ts:195` | No | - | The caller's own console profile. |
| `program_inspect_template` | `backend/src/mcp/capabilities/program.ts:201` | No | - | Fetches and reports a manifest; nothing is stored. |
| `program_create_program` | `backend/src/mcp/capabilities/program.ts:213` | No | - | Its plan: the program starts empty and off air. |
| `program_rename_program` | `backend/src/mcp/capabilities/program.ts:244` | Live output | Recorded: an `OperatorChangeRecord` of who made the change, the changed field names and, for names, ids and flags, the value before and after (#236); free text, JSON, cues and template addresses are named, never valued | Declares `onAir` while the program has a scene, fade, song, queue, flight sequence or scene instant live (program.ts:269); players lose the old id. |
| `program_remove_program_song_leaves_by_id` | `alcantara:program:operate` | A | Removes exactly the playlist leaves with these ids (1 to 200, nested blocks included) against the live rotation cursor; the leaf on air is refused unless keep_rotation is set; dry_run lists what would go. |
| `program_remove_queued_program_song_by_id` | `backend/src/mcp/capabilities/program.ts:466` | Queue | Yes, through the executor's attribution wrap | Removes a Play Next entry: `ProgramService.removeQueuedProgramSong` -> `SongExecutionEngine.removeQueuedSong` (song-execution.engine.ts:682) reads the actor and emits `song_queue_update` with it. |
| `program_add_scene_to_program` | `backend/src/mcp/capabilities/program.ts:498` | No | - | Assignment only; its plan: nothing goes on air. |
| `program_add_media_group_to_program` | `backend/src/mcp/capabilities/program.ts:513` | No | - | Assignment only; takes effect when a scene or page reads it. |
| `program_add_stinger_to_program` | `backend/src/mcp/capabilities/program.ts:530` | No | - | Assignment only; played by a later scene change. |
| `program_create_flight_sequence_by_id` | `backend/src/mcp/capabilities/flight.ts:299` | No | - | A new inactive sequence; its plan: it does not air until activated and started. |
| `program_update_flight_sequence_by_id` | `backend/src/mcp/capabilities/flight.ts:322` | Live output | Recorded: an `OperatorChangeRecord` of who made the change, the changed field names and, for names, ids and flags, the value before and after (#236); free text, JSON, cues and template addresses are named, never valued | Declares `onAir` while the sequence runs (flight.ts:322): later cues of a running rundown change at once. Cues fire by timer, which reads no actor. |
| `program_generate_tagged_log` | `backend/src/mcp/capabilities/flight.ts:362` | No | - | Returns a proposal; nothing is saved or aired. |
| `program_fill_rundown` | `backend/src/mcp/capabilities/flight.ts:382` | No | - | Returns a proposal; nothing is saved or aired. |
| `program_publish_flight_sequence_by_id` | `backend/src/mcp/capabilities/flight.ts:413` | Live output | Recorded: an `OperatorChangeRecord` of who made the change, the changed field names and, for names, ids and flags, the value before and after (#236); free text, JSON, cues and template addresses are named, never valued | Schedules a log to start itself at its time; that start is automatic (timer) and stays null by design. |
| `radio_similarity_upload` | `backend/src/mcp/capabilities/similarity.ts:87` | No | - | Embeddings for song similarity; they inform later automatic picks only. |
| `radio_update_settings` | `backend/src/mcp/capabilities/radio.ts:204` | Live output | Recorded: an `OperatorChangeRecord` (see "Operator change records" below) | Declares `onAir` for the live settings (radio.ts:225: Palazzo address, bumpers, segue, similarity, enabled). |
| `radio_prepare_recovery` | `backend/src/mcp/capabilities/radio.ts:266` | No | - | A prepared version; a running session keeps its own. |
| `radio_replace_now_playing_consumers` | `backend/src/mcp/capabilities/radio.ts:290` | No | - | Who is told what plays; not what plays. |
| `scene_create` | `backend/src/mcp/capabilities/scenes.ts:112` | No | - | A new library scene. |
| `scene_update` | `backend/src/mcp/capabilities/scenes.ts:147` | Live output | Recorded: an `OperatorChangeRecord` of who made the change, the changed field names and, for names, ids and flags, the value before and after (#236); free text, JSON, cues and template addresses are named, never valued | Declares `onAir` while the scene is on air (scenes.ts:177): viewers see the change at once. |
| `song_create` | `backend/src/mcp/capabilities/songs.ts:155` | No | - | A new catalog song. |
| `song_update` | `backend/src/mcp/capabilities/songs.ts:173` | Live output | Recorded: an `OperatorChangeRecord` with no program (see "Operator change records for library changes" below) | Declares `onAir` while the song is playing (songs.ts:199); a queued song shows the change when it plays. |
| `stinger_create_stinger` | `backend/src/mcp/capabilities/stingers.ts:84` | No | - | A new stinger. |
| `stinger_update_stinger` | `backend/src/mcp/capabilities/stingers.ts:113` | Live output | Recorded: an `OperatorChangeRecord` with no program (see "Operator change records for library changes" below) | Declares `onAir` while a program that plays it has a scene or fade on air (stingers.ts:137). |
| `revoke_my_token` | `backend/src/mcp/capabilities/access.ts:115` | No | - | Revokes the caller's own token. |
| `import_media_from_url` | `backend/src/mcp/capabilities/media-import.ts:46` | No | - | Stores an upload; its plan: it creates no media asset and nothing changes on air. |

`backend/src/as-run/as-run.actor.spec.ts` runs
`program_remove_queued_program_song_by_id` through the real executor, the real
attribution provider and the real engine: an MCP call carries the principal, `via: 'mcp'`
and the client name, the console call carries `via: 'console'`, and an automatic
queue update carries nothing. `mcp-action.executor.spec.ts` pins that W, A and D
are wrapped and a dry run is not.

## Operator change records (#236)

`radio_update_settings` and the console route it mirrors (`PUT /radio/:programId/settings`) record who changed the
on-air radio settings in the `OperatorChangeRecord` table: the actor principal, `via` (`mcp` or `console`), the MCP
client name (null for the console), the capability (`radio_update_settings` or `radio.update-settings`), the program
and a `summary`. The summary is `{ changed, before, after }`: `changed` names the fields given; `before` and `after`
carry the value only of the enum, boolean and number settings (`bumperEnabled`, `bumperInterval`, `bumperMode`,
`enabled`, `segueMode`, `similarityMode`, `similarityThreshold`), `null` where there was none. The Palazzo and
listener addresses, the bumper instant ids and any field outside the allowlist are named at most, never valued, so
no URL, key or token reaches the table.

The record is written after the settings write and never blocks it: if the record cannot be stored, the change
stands, a warning is logged and `alcantara_radio_operator_change_records_total{result="failed"}` is counted
(`recorded` counts the stored ones). Read it with `SELECT * FROM "OperatorChangeRecord" WHERE "programId" = ... ORDER BY "createdAt" DESC`.
Scenes, layouts, rundowns and programs record the same way (next section), and so do the library capabilities (instants, stingers, songs, media; the section after it).

## Operator change records for scenes, layouts, rundowns and programs (#236)

`scene_update`, `layout_update`, `program_update_flight_sequence_by_id`, `program_publish_flight_sequence_by_id` and
`program_rename_program`, and the console routes that make the same changes, write one `OperatorChangeRecord` after
the change: the actor principal, `via` (`mcp` or `console`), the MCP client, the capability (or the route name:
`scene.update`, `layout.update`, `program.update-flight-sequence`, `program.publish-flight-sequence`,
`program.rename`) and a `summary`. A scene or layout belongs to no single program, so its record has no `programId`;
a rundown change carries its program and a rename carries the new program id. The summary holds
`target: { kind, id }` (`scene`, `layout`, `flight_sequence`, `program`), `changed` (the fields given) and
`before`/`after` for the fields that may carry a value (names, ids, flags, schedule, publication time and revision);
chyron text, scene metadata, layout settings, cues and template addresses are named, never valued, so no URL, key or
free text reaches the table. An automatic change (no actor) writes nothing.

The record never blocks the change: if it cannot be stored, the change stands, a warning is logged and
`alcantara_operator_change_records_total{target="scene|layout|flight_sequence|program",result="recorded|failed"}` is
counted. A scene or layout record is stored with `programId` NULL (`20261124010000_operator_change_library` made the
column nullable; `docs/operator-change-records.md` says how to read those rows).

## Operator change records for library changes (#236 slice 3)

Seven library writes, from the MCP and from the console routes that make the same change, write one
`OperatorChangeRecord` after the change through the same recorder. A library item belongs to no single program, so the
record has `programId` NULL (`20261124010000_operator_change_library` makes the column nullable; how to read the table
with those rows is in `docs/operator-change-records.md`).

| Change | MCP capability | Console capability | Target | Valued before and after |
|---|---|---|---|---|
| Instant | `instant_update_instant` | `instants.update` | `instant` | `volume`, `enabled` |
| Stinger | `stinger_update_stinger` | `stingers.update` | `stinger` | `cutPointMs`, `enabled` |
| Song | `song_update` | `songs.update` | `song` | `durationMs`, `enabled` |
| Media (image) | `media_update` | `media.update` | `media` | none |
| Media label | `media_asset_update_label` | `media-assets.update-label` | `media_label` | none |
| Media label assets | `media_asset_replace_label_assets` | `media-assets.replace-label-assets` | `media_label_assets` | `assetIds`: the number of assets |
| Media group | `media_group_update` | `media-groups.update` | `media_group` | `mediaIds`: the number of media |

Names, URLs, descriptions, chart identifiers and the ids of a replaced list are named, never valued. As for the other
records, the change is never blocked: a record that cannot be stored is logged and counted under
`alcantara_operator_change_records_total{target,result}` with the targets above, and an automatic change writes nothing.

## Radio clocks and dayparts (#124)

File: `backend/src/mcp/capabilities/dayparts.ts` (`DaypartMcpTools`), calling the services the console routes call.
Clock names, proposed cues and the reason an hour cannot be filled are user text under `untrusted`.

| Capability | Permission | Tier | What it does |
|---|---|---|---|
| `program_list_radio_clocks_by_id` | `flight.read` | R | The program's clocks with their revision and radio log rules. |
| `program_get_radio_dayparts_by_id` | `flight.read` | R | The weekly grid: time zone, revision and dayparts. An empty grid means nothing is generated. |
| `program_preview_radio_dayparts_by_id` | `flight.read` | R | For each grid hour beginning in the next `hours` (1-24, default 2): the log already made for it, or the cues its clock would give it, or why it cannot be filled. Writes nothing. |
| `program_create_radio_clock_by_id` | `flight.manage` | W | Creates a clock. It fills no hour until the grid names it. |
| `program_update_radio_clock_by_id` | `flight.manage` | W | Changes a clock at the revision read. Hours already made keep their songs. |
| `program_delete_radio_clock_by_id` | `flight.manage` | D | Deletes a clock no daypart uses. Not recoverable. |
| `program_set_radio_dayparts_by_id` | `flight.manage` | W | Replaces the weekly grid at the revision read; the hours it names are then made and published up to two hours ahead. An empty list stops that. |

## Every registered capability by name (#220)

`backend/src/mcp/mcp.docs.spec.ts` fails when a capability is registered but is not the first cell of a row in this file, or when a row names one that is not registered. Most capabilities have a row in the sections above; the ones below are listed here from the registry's own specs (name, permission, tier, first sentence of the description). Full arguments come from `list_capabilities`.

| Capability | Permission | Tier | What it does |
|---|---|---|---|
| `destination_get_program_state` | `broadcast.view` | R | Reads the television broadcast state of a program: its selectable destinations and what the executor reports (requested and actual state, transition, readiness, active and pending destinations). |
| `destination_list_catalog` | `broadcast.manage` | R | Lists the full destination catalog with the Secrets Manager reference (not the key) each destination streams with, and its retirement and update times. |
| `destination_list_destinations` | `broadcast.view` | R | Lists the broadcast destinations an operator may select (id, display name, position, retired), in catalog order. |
| `destination_reload` | `broadcast.operate` | A | Loads a destination selection into the stopped television executor of a program without going live. |
| `destination_rename_destination` | `broadcast.manage` | W | Changes the display name of a destination. Its stream key and Secrets Manager reference are not touched; adding a destination and replacing a key are console-only because they carry a credential. |
| `destination_reorder_destinations` | `broadcast.manage` | W | Sets the catalog order. |
| `destination_restore_destination` | `broadcast.manage` | W | Restores a retired destination so it can be selected again. |
| `destination_test_destination` | `broadcast.manage` | A | Asks a saved destination's ingest whether it takes its address and key (RTMP publish handshake, no media): accepted, refused or unreachable, never the key. One test per destination per 15 seconds, shared with the console button. |
| `destination_retire_destination` | `broadcast.manage` | W | Retires a destination: it can no longer be selected for a start (a replay of an older selection that includes it is refused too). |
| `destination_start` | `broadcast.operate` | A | Starts the television broadcast of a program to the selected destinations: the stream goes out live to every one of them. |
| `destination_stop` | `broadcast.operate` | A | Stops the television broadcast of a program: the stream ends for every destination. |
| `external_source_create` | `alcantara:webrtc:operate` | A | Creates an external source of the team for one to 16 programs. |
| `external_source_get` | `alcantara:webrtc:read` | R | Reads one external source: transport, lifecycle, health, programs, credential version, ingress and participant identity. |
| `external_source_list` | `alcantara:webrtc:read` | R | Lists the external sources of the team (name, transport, lifecycle, health, programs, credential version), active ones first. |
| `external_source_reconcile` | `alcantara:webrtc:operate` | A | Records the lifecycle and health an external source reports (and its ingress and participant identity). |
| `external_source_redirect` | `alcantara:webrtc:operate` | A | Checks whether an address is allowed as a redirect of an HLS or SRT source (scheme, no user name, a public address). |
| `external_source_update` | `alcantara:webrtc:operate` | A | Changes the name, programs, normalization profile or transport address of an external source; only the fields given change. |
| `filler_get_state` | `broadcast.view` | R | Reads the pending (next session) and active (in session) filler version of each leg of a program: checksum, status, sources and order. |
| `filler_prepare_radio` | `broadcast.manage` | W | Prepares one to 100 distinct enabled audio media assets as the radio filler of a program, in order or shuffled with a seed. |
| `filler_remove_radio` | `broadcast.manage` | W | Removes a program's radio filler configuration; the older recovery playlist is what the next recovery start binds. Nothing on air changes. |
| `filler_prepare_television` | `broadcast.manage` | W | Prepares an enabled image or video media asset as the television filler of a program: the executor must acknowledge the exact asset before the version becomes the pending (next session) filler. |
| `import_media_from_url` | `alcantara:upload:create` | W | Fetches a file from an https address on the public internet and stores it as an instant, background, song, artwork or stinger upload, exactly as the console stores a file it is sent: instant, background and song take audio content types (at most 200 MiB), artwork an image (avif, gif, jpeg, png or webp, at most 10 MiB) and stinger a video/webm (at most 50 MiB). |
| `instant_list_instants` | `alcantara:instant:read` | R | Lists every instant (a short audio clip played over the program) in the console order, with whether it can still be assigned as a song intro and, for program_id (default main), which song it introduces there. |
| `layout_create` | `alcantara:layout:manage` | W | Creates a layout (a component type with settings); its name must be unique. |
| `layout_update` | `alcantara:layout:manage` | W | Changes the name, component type or settings of a layout; only the fields given change. |
| `media_asset_create_background_audio` | `alcantara:media:manage` | W | Creates a background audio asset (a name, a source address and a default volume from 0 to 1, default 1). |
| `media_asset_create_label` | `alcantara:media:manage` | W | Creates a media label (a unique name and an optional description). |
| `media_asset_replace_asset_labels` | `alcantara:media:manage` | W | Replaces the whole list of labels of an asset (label_ids); the asset keeps its position in a label it stays in and goes last in a new one. |
| `media_asset_replace_label_assets` | `alcantara:media:manage` | W | Replaces the whole ordered list of assets of a media label (asset_ids); assets it drops stay, only their place in the label goes. |
| `media_asset_update_label` | `alcantara:media:manage` | W | Changes the name or description of a media label; a field left out stays, null clears the description. |
| `media_create` | `alcantara:media:manage` | W | Adds an image (a name and an image address) and creates its media asset. |
| `media_group_create` | `alcantara:media:manage` | W | Creates a media group (a unique name, an optional description and an ordered list of existing media). |
| `media_group_update` | `alcantara:media:manage` | W | Changes the name, description or ordered media of a media group; only the fields given change, and media_ids replaces the whole list. |
| `media_list_artist_labels` | `media.read` | R | Lists the media label attached to each artist: the normalised artist key, the artist as last saved and the label id. |
| `media_set_artist_label` | `media.manage` | W | Attaches a media label to an artist (matched ignoring case and outer spaces), replacing any label already attached, or removes the link when label_id is null. It changes which pictures the artist bumper and the song recipe use for every song by that artist. |
| `media_update` | `alcantara:media:manage` | W | Changes the name or image address of an image; a field left out stays. |
| `preference_discover` | `alcantara:access` | R | Lists the shared console layouts published for a program or for the team (name, description, source device class, version). |
| `preference_get` | `alcantara:access` | R | Reads your own console profile for a device class (desktop, tablet or phone); the default profile at version 0 when none is saved. |
| `preference_load` | `alcantara:access` | W | Copies a shared layout into your own console profile for its device class. |
| `preference_publish` | `alcantara:layout:manage` | W | Publishes your console profile as a shared layout for a program or the team, under a name. |
| `preference_save` | `alcantara:access` | W | Saves your own console profile for a device class. |
| `program_activate_scene` | `alcantara:program:operate` | A | Puts an assigned scene on air on the default program ('main'); the scene it replaces becomes the staged scene. |
| `program_activate_scene_by_id` | `alcantara:program:operate` | A | Puts an assigned scene on air on a television program; the scene it replaces becomes the staged scene. |
| `program_add_media_group_to_program` | `alcantara:program:manage` | W | Assigns a media group to a television program. |
| `program_add_scene_to_program` | `alcantara:program:manage` | W | Assigns a scene to a television program (radio programs take no scenes). |
| `program_add_stinger_to_program` | `alcantara:program:manage` | W | Assigns a stinger to a television program. |
| `program_create_program` | `alcantara:program:manage` | W | Creates a program (tv by default; radio programs take no visual template) and returns its ids. |
| `program_enqueue_program_song_by_id` | `alcantara:program:operate` | A | Adds a song of the program playlist to the Play Next queue (at most 100 entries). |
| `program_inspect_template` | `alcantara:program:manage` | W | Fetches a program template manifest (public https only, under the outbound-request policy) and reports what it declares. |
| `program_reload_program` | `alcantara:program:operate` | A | Tells every live page of the default program ('main') to reload. |
| `program_reload_program_by_id` | `alcantara:program:operate` | A | Tells every live page of a program to reload. |
| `program_remove_queued_program_song_by_id` | `alcantara:program:operate` | W | Removes one entry from the Play Next queue (not the one playing). |
| `program_rename_program` | `alcantara:program:manage` | W | Renames a program, changes its type, or sets (or clears, with null) its template. |
| `program_reorder_program_song_queue_by_id` | `alcantara:program:operate` | A | Sets the order of the Play Next queue; the ids must be exactly the queued entries. |
| `program_set_fade_to_black_by_id` | `alcantara:program:operate` | A | Turns fade to black on or off on a television program. |
| `program_stage_scene_by_id` | `alcantara:program:operate` | A | Stages an assigned scene to go on air next on a television program, or clears the staged scene with null. |
| `program_stop_program_scene_instant_by_id` | `alcantara:program:operate` | A | Stops the scene background audio playing on a program. |
| `program_take_program_off_air` | `alcantara:program:operate` | A | Takes the scene on air (and fade to black) off the default program ('main'). |
| `program_take_program_off_air_by_id` | `alcantara:program:operate` | A | Takes the scene on air (and fade to black) off a program and stops its scene background audio. |
| `program_take_program_scene_instant_by_id` | `alcantara:program:operate` | A | Plays the background audio of a scene (the configured one, or the instant or media asset named) on a program, on loop, until it is stopped. |
| `program_take_program_song_off_air` | `alcantara:program:operate` | A | Stops the song playing on the default program ('main') and turns its rotation to manual. |
| `program_take_program_song_off_air_by_id` | `alcantara:program:operate` | A | Stops the song playing on a program and turns its rotation to manual (the operator Stop). |
| `program_update_broadcast_settings` | `alcantara:program:operate` | A | Changes the global broadcast settings (time override, mixer levels, mute and solo) that every program reads. |
| `program_update_program_audio_bus_by_id` | `alcantara:program:operate` | A | Replaces the song sequence (playlist and rotation mode) and/or the mixer settings of a program. |
| `radio_get_playback_state` | `alcantara:radio:read` | R | Reads what the radio is playing now in a program: the song on air (elapsed and duration in milliseconds, progress, intro status, whether telemetry is stale), the song announced next, and the rotation mode and frozen flag; `on_air` is null when nothing plays. |
| `radio_get_recovery` | `alcantara:radio:read` | R | Reads the recovery (filler) session of a radio program: the selected songs, the prepared version and Palazzo's automation state; `connection` is "unavailable" when Palazzo cannot be reached. |
| `radio_get_settings` | `alcantara:radio:read` | R | Reads the radio settings of a program (Palazzo address, listener address, bumpers, recovery playlist, segue and similarity settings); null when the program has none yet. |
| `radio_get_status` | `alcantara:radio:read` | R | Reads whether the radio engine of a program is running (liquidsoap and icecast connected). |

`radio_get_playback_state` and `get_on_air` both read what is on air, but differ: `radio_get_playback_state` is a capability of the registry and returns the song's elapsed time, duration and progress with the next song, the mode and the frozen flag; `get_on_air` is the radio tool and adds the Palazzo connection and the output confidence. Both answer `not_found` for an unknown program and `on_air: null` when nothing plays. Title and artist are user-entered and are returned only under `untrusted`.
| `radio_get_audio_levels` | `alcantara:radio:read` | R | Reads the latest audio levels of a program per channel (song, instants, scene_instant, main): vu, peak and peak_hold, each from 0 to 1, with the time they were last updated. |
| `radio_list_now_playing_consumers` | `alcantara:radio:read` | R | Lists the endpoints that are told what is playing: name, address, method, enabled and position. |
| `radio_now_playing_publishing` | `alcantara:radio:read` | R | Says whether now-playing updates are published ("enabled") or held back on a local stack ("blocked-local"). |
| `radio_play_instant` | `alcantara:radio:operate` | A | Plays an instant (a short sound) at an audio address over a radio program, at an optional volume from 0 to 1. |
| `radio_play_song` | `alcantara:radio:operate` | A | Plays the song at an audio address now on a radio program, as the console's manual play does. |
| `radio_prepare_recovery` | `alcantara:radio:manage` | W | Prepares one to 100 distinct catalog songs as the recovery (fallback) playlist: Palazzo downloads and verifies them, and the version is saved only after it reports ready. |
| `radio_replace_now_playing_consumers` | `alcantara:radio:manage` | W | Replaces the whole list of endpoints that are told what is playing: any consumer not in the list is deleted. |
| `radio_similarity_upload` | `alcantara:radio:manage` | W | Stores embeddings computed outside the console for up to 25 songs: {schema: 1, model: {name, version, license}, windowSeconds, songs: [{songId, audioSha256, opening, closing}]}. |
| `radio_start_recovery` | `alcantara:radio:operate` | A | Starts the recovery (fallback) session of a radio program, bound to the program radio filler version (or, without one, the prepared recovery playlist): when the live song queue runs dry, Palazzo plays the local playlist. Refused with on_air, as the desk's Start with fallback is disabled, while Palazzo reports its playout down, with no prepared playlist, when Palazzo is not connected, or while a session runs. |
| `radio_stop_all_instants` | `alcantara:radio:operate` | A | Cuts every instant playing over a radio program. |
| `radio_stop_recovery` | `alcantara:radio:operate` | A | Stops the recovery session of a radio program: the program audio is cleared and the binding to the playlist is dropped. Refused with on_air, as the desk's Hold · stop session is disabled, when no session runs. |
| `radio_stop_song` | `alcantara:radio:operate` | A | Stops the song that is playing on a radio program and tells the engine to stop. |
| `radio_update_settings` | `alcantara:radio:manage` | W | Changes the radio settings of a program (Palazzo address, listener address, bumpers, segue, similarity, enabled). |
| `recording_start` | `alcantara:program:operate` | A | Starts recording the program output on the executor: it writes segments to its disk, up to the quota, until stopped. |
| `recording_status` | `alcantara:program:read` | R | Reads the recording of a program: state, times, size, segments, errors, finalization and disk quota. |
| `recording_stop` | `alcantara:program:operate` | A | Stops the recording and finalizes it into one file. |
| `recording_tape_start` | `alcantara:program:operate` | A | Starts the tape of the program on the executor (the executor refuses while the program is live and answers program-live). |
| `recording_tape_status` | `alcantara:program:read` | R | Reads the tape (the program-level recording the executor keeps) of a program: whether it is enabled, active and healthy, with the recording it feeds. |
| `recording_tape_stop` | `alcantara:program:operate` | A | Stops the tape and finalizes the recording it feeds. |
| `scene_create` | `alcantara:scene:manage` | W | Creates a scene on a layout. |
| `scene_draw_modo_italiano_bracket` | `alcantara:scene:operate` | A | Starts the animated draw that fills the next open opening slot of the scene bracket from its random song pool. |
| `scene_open_modo_italiano_bracket_voting` | `alcantara:scene:operate` | A | Opens voting for one match of the scene bracket (both songs set, no winner yet). |
| `scene_update` | `alcantara:scene:manage` | W | Changes the name, layout, chyron text, metadata or external source of a scene; only the fields given change. |
| `scene_update_chyron` | `alcantara:scene:operate` | A | Sets the chyron (lower-third) text of a scene; where the scene is on air, viewers see it at once. |
| `scene_vote_modo_italiano_bracket` | `alcantara:scene:operate` | A | Records one registered voter's vote (a song of the match, or null to withdraw it) in the scene bracket; a majority decides the match. |
| `song_create` | `alcantara:song:manage` | W | Adds a song to the catalog (artist or title, and an audio address) and creates its media asset; an intro Instant may be set for a program (default main). With no title, an artist of the form "Artist - Title" (one " - ") is stored as both. |
| `song_request_reanalysis` | `alcantara:song:manage` | W | Queues up to 25 songs for a new audio analysis (cue points and loudness), taken one at a time by the media-analysis job at low priority (#235). A song keeps its current cue points until its new result replaces them; a song that is playing on a program or announced there as the next song is refused `on_air` (per song in the dry run), checked again when queued. Console route `POST /songs/reanalysis`. `rule` is `C2` (the default, the current cue rule: a quiet tail beyond the 1.5 s bound is cut 1.5 s before the old cue-out), `C` (the rule before the clamp, which keeps the old cue-out there) or `previous` (the rule before #235): `C` and `previous` are a way back for a bad batch that needs no deploy; the rule that ran is the song's `ruleVersion`. |
| `song_update` | `alcantara:song:manage` | W | Changes the given fields of a song; a field left out stays, null clears cover_url, duration, the chart values and the intro. |
| `stinger_list_stingers` | `alcantara:stinger:read` | R | Lists every stinger (a transition video played between scenes) with its cut point, enabled flag and times, newest change first. |
| `webrtc_admit_guest` | `alcantara:webrtc:operate` | A | Admits a waiting guest onto their strip (screening before air); refused for a guest who is not waiting, as the desk offers Admit only to one. |
| `webrtc_control_participant` | `alcantara:webrtc:operate` | A | Sends one command to a connected guest of a program room: type "media" (device camera or microphone, enabled; disabling mutes the published track), "cue" (standby, live or wrap), "message" (text of up to 500 characters shown to the guest) or "talkback" (enabled). |
| `webrtc_health` | `alcantara:webrtc:read` | R | Says whether the call chain of a program works now, as the calls desk reads it: returnRunner (whether guests are sent the studio sound), contribution (whether a cued guest can reach air) and livekit (whether the calls server answers), each ok, down or unknown (livekit is only ok or down), with checkedAt. unknown means nothing has been heard either way, for example for a few seconds after a backend restart; it is not ok. |
| `webrtc_list_invitations` | `alcantara:webrtc:read` | R | Lists the guest invitations (program, guest name, slot, return feed, gain, expiry, status and the last ten commands sent). |
| `webrtc_list_participants` | `alcantara:webrtc:read` | R | Lists the guests invited to a program room: whether each is connected, reconnecting or offline; whether each is waiting to be admitted (screening); whether their return feed is reaching them (returnReaching: healthy, stalled or missing, null until their page reports); the cue that holds now (cueState: live, standby, wrap, rejoined for a guest cued live who came back off air and needs a new cue, or null when none was sent); and their tracks and recent commands. The operator's own "Mic on air" is not in this list; webrtc_host_mic_off takes it off air. |
| `webrtc_host_mic_off` | `alcantara:webrtc:operate` | A | Takes the operator's own microphone off air in a program: each published host microphone track (Mic on air) is muted on the server, so it stops reaching air whatever the page does. When no host microphone is published it reports no-host-mic and mutes nothing. Reports muted only after LiveKit confirms each mute. |
| `webrtc_update_return` | `alcantara:webrtc:operate` | A | Sets the return feed of an invitation: the video (program, preview or none), the audio bus (master, monitor or aux-1 to aux-8), the gain from 0 to 1, mute and delay up to 2000 ms. |

## The radio desk's rotation and guest screening (#788)

File: `backend/src/mcp/capabilities/rotation.ts`, registered in the MCP module. These have no route of their own: each
reads the rotation as `GET /program/:programId/audio-bus` gives it and writes it back with the console's own save. Every
write takes the `sequence_version` that `radio_get_rotation` returned, names it in its confirm target, and sends it with the
save: a rotation that changed since that read is refused, and nothing is written. The writes ask for
`alcantara:program:operate`, except `radio_take_rotation_song`, which puts a song on air and asks for
`alcantara:radio:operate`, as the console's `POST /radio/:programId/song` does.

| Capability | Desk action | Tier |
|---|---|---|
| `radio_get_rotation` | the rotation: mode, loop, cursor, ended, rows with `item_id`, play order | R |
| `radio_set_rotation_mode` | Manual, Autoplay, Shuffle (a new play order, rows untouched), Loop | A |
| `radio_take_rotation_song` | Take on air on a rotation row; refused while the engine is off or playout is down | A |
| `radio_move_rotation_song` | Move up, Move down, drag | A |
| `radio_add_rotation_song` | Add fillers, and undoing a removal | A |

Guest screening is `webrtc_admit_guest` (A) and `webrtc_decline_guest` (D) in the guests area above. Pre-listen plays
on the operator's own device and has no capability; Cue next and Clear cue arm only in the console.

Parity with the desk, as of the MCP parity audit: cue a guest live and wrap them is `webrtc_control_participant` with type `cue` (live, wrap, standby). The on-air list is `get_on_air` `webrtc_health` is the desk's call-chain health line, and `webrtc_list_participants` gives each guest's cue (`cueState`), studio-sound state (`returnReaching`) and whether they are waiting (`screening`). Host "Mic on air" can be taken off by `webrtc_host_mic_off`, which mutes the published track on the server. Turning it on remotely has no capability: the microphone is published from the browser, and that stays a separate decision.

