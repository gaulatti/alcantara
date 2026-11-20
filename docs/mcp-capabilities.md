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
each registered in the module of the services it calls. The 57 rows of
appendix A that are not excluded and not another ticket's:

| Area | R | W | A | D | Total |
|---|---|---|---|---|---|
| broadcast destinations (`destination_*`) | 3 | 5 | 3 | 0 | 11 |
| filler (`filler_*`) | 1 | 2 | 0 | 0 | 3 |
| recording and tape (`recording_*`) | 2 | 0 | 4 | 0 | 6 |
| radio (`radio_*`: settings, Palazzo, recovery, now-playing, manual song and instant) | 7 | 3 | 6 | 0 | 16 |
| operator preferences (`preference_*`) | 2 | 3 | 0 | 3 | 8 |
| external sources (`external_source_*`) | 2 | 0 | 4 | 1 | 7 |
| guests (`webrtc_*`) | 2 | 0 | 2 | 2 | 6 |
| **Total** | **19** | **13** | **19** | **6** | **57** |

`backend/src/mcp/capabilities/appendix-a-broadcast.spec.ts` reads these rows
from `appendix-a.tsv` and asserts, for each, the capability's name, permission
(and that it is the controller handler's own), tier, a dry run for every W, A
and D, and a confirm target for every A and D.

**Not capabilities.** Appendix A marks seven rows excluded (capability
column `—`) because they return or produce a credential:
`POST /auth/realtime-ticket`, `POST /radio/:programId/monitor-ticket`,
`POST /program/:programId/recording/download-ticket`,
`POST /external-sources/:id/credentials/rotate`, `POST /webrtc/operator-token`,
and the two routes whose whole product is a guest link,
`POST /webrtc/invitations` (create) and
`POST /webrtc/invitations/:id/replace` (replace; it also disconnects the
guest). A guest link is created and replaced in the console only. The four
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
  automation state; the manual song and instant routes
  (`radio_play_song`, `radio_stop_song`, `radio_play_instant`,
  `radio_stop_all_instants`) confirm against the program's live stamp, like
  the program actions. `radio_play_instant` accepts `instant_id` as the
  console sends it; the route does not use it.
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

## The rows no ticket owned (#226)

Appendix A is 167 rows: 154 are capabilities, 6 are `covered by` another tool
(`whoami` or `import_media_from_url`; 160 capability rows in all) and 7 are
exclusions (they return or produce a credential).

| Row | Outcome | Why |
|---|---|---|
| `auth_get_me` | covered by `whoami` | Same permission (`access`), same tier (R), no service behind either: both answer the caller's own identity from the verified token. `whoami` carries subject, principal id, client and the sorted permissions; the console's route also returns the Pompeii role names and team id, which the MCP principal does not hold. |
| `as-run_export` | registered capability (`backend/src/mcp/capabilities/as-run.ts`) | Not covered by `get_as_run`: that tool lists rows as data through `AsRunService.listRecords` in a window of at most `asRunWindowDays`; the row is the download, `AsRunService.export`, a CSV of the log or the SoundExchange report of use over any window. Same permission (`radio.read`) and tier (R). Args `program_id`, `from`, `to`, `format` (`csv` or `soundexchange`), `inferred`; the file text is in `untrusted.csv` with `program_id` and `format`. |
| `radio_get_palazzo_status` | capability (already registered by #219) | Mirrors the controller: `PalazzoRadioTelemetryService.getStatus`, `radio.read`, R, `firstClass: false`. |
| `radio_get_output_confidence` | capability (already registered by #219) | Mirrors the controller: program check, then `RadioOutputConfidenceService.get`; `radio.read`, R. |
| `upload_artwork`, `upload_stinger` | covered by `import_media_from_url` | The import now takes both kinds with the upload routes' type and size limits. |

The exclusions are unchanged. `as-run_export` has no byte cap, as the console's
download has none; the framework's own limits apply. The area adds no metric.
