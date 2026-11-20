
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
