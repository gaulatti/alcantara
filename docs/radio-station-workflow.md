# Radio station workflow

## Library tags and the on-air log

The base playout is a **continuous filler rotation**, shown in the Radio desk with its saved songs, existing queued overrides, actual engine feedback, and Manual/Autoplay/Shuffle/Loop controls. Loop with Autoplay or Shuffle runs indefinitely: no hourly schedule is required. Opening the desk never writes the sequence or sends a playback command. A future timed block does not hide or take ownership of the current rotation. The bottom player is the sole now-playing display.

**Rundown** manages optional timed content blocks. Its persistent continuous-fillers summary links directly to the rotation and live controls. Blocks are not one-hour containers: choose any start minute, use fixed offsets beyond an hour if needed, and finish after the last content event. Do not create 24 copies of a rotation to cover a day.

Scheduled content takes temporary ownership of audio without overwriting the persisted rotation or its queue. At normal completion, the backend persists the next rotation cursor while the block still owns audio, stops the block, then asks the existing engine to continue. Manual mode and a finished non-looped rotation do not start automatically. A cut filler is not resumed halfway through; the next continuous selection starts. Upcoming fixed events cut the preceding audio on time. An explicit Stop within a block keeps silence until its next event. A final Stop finishes the block and returns to automatic continuous fillers. Resume persistence failures emit `radio_rotation_resume_failed` and increment a bounded failure result. An operator Stop or failed cue does not call the completion resume path.

## Library tags

Build from tags previews concrete enabled catalog songs for a timed block, with artist separation and preference for songs used least recently in the previous 24 published blocks. Review, Save, then Publish. Preview generation never persists or publishes automatically; saved songs remain concrete selections when tags change later. `POST /program/:programId/flight/:sequenceId/generate` requires `flight.manage` and `{revision,rules:{slots:[{labelId,count,clockOffsetSeconds?}],artistSeparation}}`. It accepts only an unaired unpublished draft and returns `{items}`. Insufficient songs, deleted tags, invalid offsets, and stale revisions are explicit errors.

## Scheduled rundowns

Radio and Simulcast shows use **Rundown** at `/flight`. An operator creates a future local start time, adds catalog songs, audio clips, or a stop cue, and optionally assigns a fixed start in seconds from the scheduled time. The first item starts at zero. Unfixed items follow the previous song's confirmed Palazzo end event. A fixed start cuts to that item at its clock position. Logs cannot loop.

Save keeps the log a draft. **Check** validates cue shape and referenced enabled audio. **Publish** repeats validation and marks the block for automatic start. The backend claims a published block once when its time arrives; a failed start is visible through the `radio_log_start_failed` event and is not retried automatically after an ambiguous failure. The planner and Radio desk show the current and next items. On-air and already played items are locked; stopped/previously aired logs cannot be rewritten, and published blocks cannot be rescheduled. Future items can be changed with an optimistic revision check. Cue execution and edits are serialized per program, and fixed-time timers are rebound to cue IDs after an edit. A log cannot be published for a past start time. Scheduled logs require the backend process to be running when the block begins. If the process is down beyond five seconds after the block, the log is not started late.

The existing `/program/:programId/flight` list, create, update, activate, and start APIs carry the additive `scheduledAt`, `publishedAt`, `lastStartedAt`, and `revision` fields. `GET .../flight/:sequenceId/preflight` returns `{ready,issues}`; `POST .../publish` accepts `{revision}`. Program `flight.read` and `flight.manage` permissions remain in force.

## Song similarity selection

By default the continuous rotation follows its saved order. A station can opt in to choosing the next playlist song by audio similarity (`off`, `shadow` or `on`; default `off`, which changes nothing). It applies only where the engine picks the next playlist song: queued songs, manual songs, timed blocks and the high-rotation quota keep their precedence, and favorites are never ranked. When no song qualifies the engine falls back to the saved order. See [song-similarity.md](song-similarity.md) for the model, artist cycle, fallback rules and how to run the analysis.

## Playout segues and loudness normalization

Radio settings created from now on have segue-aware and loudness-normalized playout on (`segueMode: 'on'`). A station can turn it off by setting `segueMode` to `'off'` in `RadioSettings`, which sends unchanged payloads to Palazzo. Settings saved before this default changed were turned on by migration `20261120000000_radio_segue_mode_on_for_existing`, which keeps each program's previous value in `segueModeBeforeDefaultOn` (see [program-playout.md](program-playout.md)). To turn it off for one program, send `PUT /radio/:programId/settings` with `{"segueMode": "off"}`. When on and media asset analysis is present, Alcantara embeds measured `segue` (cue-in, cue-out, fade, overlap) and `loudness` (integrated LUFS, true peak) into the playout song command according to the specification in [program-playout.md](program-playout.md). If analysis is absent or marked failed, song playback continues uninterrupted with default parameters. The analysis is written by the media analysis job described in [media-library-architecture.md](media-library-architecture.md#audio-analysis).

## Voice tracks

Use **Voice** on a song row to record a link with the browser microphone. Preview the take alone or over the chosen song, set duck and fade values, then **Use this take**. The recording uploads as a managed audio clip and is attached to that exact cue by `voiceTrackInstantId`; changing another play of the same song does not change this cue. Palazzo receives the voice clip with the song command and applies the saved duck/fades. Browser preview approximates the mix. A missing or disabled clip fails preflight; if it disappears between preflight and playout, the Radio desk shows intro degradation.

## Output confidence and recovery

The Radio desk separates **STREAM CONNECTED** (Liquidsoap and Icecast transport) from output confidence. It shows fresh sampled output as detected, checking, silent after ten seconds below 0.001 RMS while song playback is expected, idle, unavailable, or unverified. A sample older than fifteen seconds cannot prove audio. This is a level check, not a listener-side measurement.

**Engine audio detected** measures Palazzo's post-master mix before Icecast.
**Listen** returns Icecast audio through Palazzo and Alcántara's
backends using the station's existing private Palazzo connection. It requires no
public listener URL or manual configuration. Listening and monitor volume affect
only the operator's device; Stop listening never stops broadcast playback.
Listen, Stop listening, and Monitor volume are inline in the Radio desk's
Output confidence panel. The header headphones action and command palette focus
these controls in the same tab. Failures are visible and can be retried; no
public-stream fallback is used.
The return audio includes Icecast buffering and does not test the public DNS/CDN
listener path.

Radio distribution contains **Prepared local playlist**. Choose one to 100 enabled songs from the managed S3 media bucket and prepare them. Alcantara reads each exact catalog URL to calculate SHA-256, then calls Palazzo's private filler preparation API with the same URL and checksum. Palazzo downloads, verifies, normalizes, and stores the version locally. The version and selected song IDs are saved only after Palazzo reports ready. Preparing a new version does not replace the active one. The Radio desk's **Start with fallback** binds the prepared version to a new Palazzo automation session; **Stop session** clears program audio and the binding. Palazzo's local playlist plays when its live song queue runs dry. Start/stop use Palazzo's monotonic command sequence and idempotency key. If Palazzo is unreachable, controls show an error and do not claim recovery is active. Once a program radio filler is configured ([`program-filler.md`](program-filler.md)), preparation through this panel is refused and **Start with fallback** binds that configured version instead.

Only exact HTTPS URLs on the configured `MEDIA_S3_BUCKET` S3 host are accepted for preparation. Redirects and files above 512 MiB are rejected. The backend uses the existing private Palazzo URL allowlist; the browser never calls Palazzo directly. Palazzo is an external dependency and is not included in Alcantara's local Compose stack, so local UI can show an unavailable recovery state until a Palazzo instance is attached to the documented private URL.

## Operations and metrics

`alcantara_radio_monitor_sessions_total{result="opened|closed|aborted|failure|rejected"}`
counts monitor connection transitions, including repeated native media requests
and rejection after the grant's idle deadline. `output-monitor` is a bounded
operation
in the existing Palazzo dependency request metrics. There are no station IDs,
stream URLs, tickets, or free-form errors in metric labels. The old
`alcantara_radio_listener_configuration_total{result="success|failure"}` remains
for compatibility with the earlier listener URL settings API, which the monitor
no longer uses.
It is exposed through the same authenticated private `/metrics` boundary and
contains no URL or station labels. Updating only the listener URL does not
reconnect Palazzo telemetry. The nullable database column is additive; reverting
application code safely leaves it unused without removing station data.

The authenticated private `/metrics` endpoint includes `alcantara_radio_log_transitions_total{result}` with bounded `interrupted`, `completed`, `resume-failed`, `filled`, `fill-failed`, `generated`, `generation-failed`, `edited`, `edit-failed`, `published`, `started`, `start-failed`, `cue-failed`, `preflight-failed`, and `poll-failed` results; `alcantara_radio_output_confidence_transitions_total{state}` with bounded confidence states; `alcantara_radio_output_silent_programs`; `alcantara_radio_recovery_preparations_total{result}` with bounded `ready` and `failed` results; and the existing Palazzo request/retry metrics with `filler-prepare` and `automation-*` operations. No program, song, URL, version, or error text appears in metric labels. The Radio desk shows active and upcoming log state and recovery readiness; inspect Palazzo's filler metrics and lifecycle state for its local playback and preparation details.

## Fillers between timed blocks

Build and review content first, then select its filler tag and artist separation in **Fill the gaps**. `POST /program/:programId/flight/:sequenceId/fill` requires `flight.manage` and `{revision,items,rules:{labelId,artistSeparation}}`, and returns a preview `{items,warnings}`. The input includes the current reviewed draft, including unsaved content. The endpoint accepts only unaired unpublished scheduled drafts, checks program scope and revision, and does not save or publish.

The preview preserves content cue IDs and fixed starts, replaces only previously generated fillers, and materializes catalog song IDs for every gap to the next explicit fixed boundary. Songs already present as content are reserved and fillers do not repeat within the block. Selection favors songs used least recently in the previous 24 published blocks; whole songs that fit are preferred, otherwise the shortest eligible song covers the remaining gap and its cut is reported. Artist separation applies across content and fillers. Unknown-duration filler songs are excluded with a warning. Unknown content duration, content overrun, an insufficient tag pool, or more than 120 events fails explicitly without changing the draft.

Standalone audio clips require an accurate declared duration; scheduled execution takes music off air at clip start and waits that duration before following events. A fixed start still takes precedence. Clips use the existing shared instant-audio channel and are not forcibly stopped individually; the declared duration must cover the actual clip. Explicit Stop content leaves intentional silence rather than filling it. The preview does not add an end boundary. Add a fixed final Stop yourself when the block must finish at a precise time. Saved fillers carry `isFiller:true` through validation, storage, reload, and rendering; tags are not read during playout. Filler previews record bounded `filled` and `fill-failed` results in the existing private radio log transition metric. No database migration is required.

## Continuous rotation and block migration

No database migration or automatic rewriting of saved data is needed. Existing rotations remain in `ProgramState.songSequence`; scheduled song cues no longer replace them with a one-song manual sequence. Existing hourly blocks, including explicit +3600 Stop boundaries, continue to work as authored. New filler previews add songs only before an existing fixed boundary; they never invent an hourly end or append material after the last content event. Library tags remain preview selection inputs; tag edits do not silently alter persisted playout. The 120-event limit applies to an individual timed block, not to the continuous rotation or broadcast day. Fixed cue timers recheck distant boundaries in bounded timer chunks rather than overflowing the runtime timer limit.

An explicit operator Stop takes audio off air and sets the base rotation to Manual, preventing an idle telemetry snapshot from starting it again. This holds for every Stop path, including `POST /radio/:programId/song/stop`: the song engine itself turns an Autoplay or Shuffle rotation Manual and persists it, cued past the stopped song, so neither idle snapshots nor a backend restart start playback. Playback resumes only when the operator acts: Play (the rotation set back to Autoplay or Shuffle) or a manual pick. Only operator stops halt: a stop the flight itself drives (a manual flight ending, a failed timed cue, a failed rotation resume, a rundown Stop song cue) keeps the rotation's mode and cues it past the stopped song, so it neither halts nor replays. Internal timed-block cuts preserve the rotation and cursor.

On backend restart, scheduled blocks whose in-memory timers were lost are marked interrupted (`isRunning:false`) without resetting `lastStartedAt` or rewriting the rotation. They are not replayed automatically. The continuous engine retains its normal authoritative Palazzo snapshot reconciliation before sending a new selection. The bounded `interrupted` metric counts startup batches containing such blocks.

## As-run log and royalty export

The as-run store subscribes to the song engine's `trackEvents$` and writes one
`AsRunRecord` per accepted transition: a `started` row when the engine adopts a
start of its own active song, and an `ended` row when the engine accepts an end
and advances. The engine emits nothing for transitions it ignores (mismatched,
duplicate, frozen, or no active song) or for a start that confirms a command
another song, such as a manual pick, already replaced.

**Inferred ends.** When the real `track.ended` never reaches the engine (for
example the event stream dropped) and an authoritative idle snapshot ends the
song (including a state the playback watchdog read, #230), the engine emits a `track.ended` with `inferred: true` at the moment it
advanced. The record stores `inferred = true`. If it closes a play shorter than
30 seconds after its recorded start, or no start was recorded, it also carries a
`reviewFlag` of `short` or `no-start`. Thirty seconds is a review threshold, not
a royalty rule: a play that brief behind a dropped connection is more likely a
stale reconnect or an immediate skip, so an operator should look at it.

**Starts adopted from a snapshot.** When the engine adopts a song from a
playing snapshot without having seen its start (for example after a backend
restart mid-song), it emits one `track.started` with `inferred: true`, at
Palazzo's reported start time (`track.startedAt`), or at the snapshot time when
the snapshot carries none. The `started` row stores `inferred = true` and no
`reviewFlag`; the play's end is then no longer flagged `no-start`. If the real
`track.started` also arrives, the unique key keeps one row.

**Ends the engine causes.** When the engine itself ends a song that had
started (Palazzo had confirmed it), it closes the play at that moment with an
`endReason`, taken from what the engine did and never from Palazzo's
stop-reason label:

- `stopped`: the operator pressed Stop.
- `replaced`: a manual pick cut the song; the manual song gets its own record.
- `superseded`: a playing snapshot reported a different track. The record is
  also `inferred = true`.
- `preempted`: a song announced to Palazzo as next (see "Gapless handoff"
  below) that Palazzo started at the handoff although it was no longer the
  engine's successor, so the engine replaced it at once. It is recorded as
  started and preempted, and never counted as a performance.

`endReason` is NULL on every other row: Palazzo's own ends, ends inferred from
an idle snapshot, all `started` rows, and every row written before the column
existed. A song that never started gets no record however it ends. No play is
dropped for being short: these ends carry the same `reviewFlag` as inferred
ends (`short` under 30 seconds after the recorded start, `no-start` without
one), so the minimum duration is a review threshold only. Whether very short
plays are reportable is a royalty decision.

**One record per play.** Records carry the engine's `playbackRequestId`, and
`(programId, playbackRequestId, state)` is unique. A real end that arrives after
an inferred end, or any repeated event, is dropped, so a play is never counted
twice. After a stop or a cut the engine also ignores the song's late end, and
after a superseding snapshot it does not close the play again. Rows written before this column existed have no request ID and are left
as they were.

**Who acted (gaulatti/alcantara#213).** A record caused by an operator also
names the acting identity, in three nullable columns: `actorPrincipalId`
(Pompeii's principal; empty while Pompeii has not resolved one), `actorVia`
(`console` or `mcp`) and `actorClient` (the MCP client name; empty for the
console). They are set on:

- the `ended` row of a `stopped` or `replaced` end, with whoever pressed Stop
  or picked the song that cut it;
- the `started` row of a manually picked song, with the picker.

Everything automatic keeps all three NULL: Palazzo's own ends, inferred and
`superseded` ends, `preempted` ends, starts of songs the rotation or the queue
chose, and every row written before the columns existed (the migration adds
them nullable and rewrites nothing). A rundown (flight) stop or pick driven by
a timer reads no actor and stays NULL. Queue changes write no as-run row; the
song events below carry their actor.

*How the actor reaches the record.* `ActorContext`
(`backend/src/auth/actor-context.ts`) is an `AsyncLocalStorage` scope per
command. A console request enters it in `ActorContextInterceptor`, a global
interceptor that runs after the authorization guard and reads the guard's
`request.user` (`principalId`, `via: 'console'`); it changes no guard
decision, and public routes carry no actor. An MCP action enters it through
the `McpAttribution` provider bound under `MCP_ATTRIBUTION`
(`via: 'mcp'` and the client name), which the action executor applies to every
W, A and D run; which W capabilities change what is on air or queued, and which
of those have a record to carry the actor, is classified in
[MCP capabilities](./mcp-capabilities.md#tier-w-and-the-actor-213). The song engine reads the context once,
when the command arrives (manual pick, Stop, queue enqueue, reorder, remove),
and carries the value with the event or the active song, so the later write
(Palazzo confirming the pick, the as-run insert) never reads it again. The
scope also expires when its command ends, so a timer created during a request
reads no actor.

*Events.* The engine's `song_off_air`, `song_playback_active` and
`song_queue_update` events and its `track.started`/`track.ended` events gain
`actorPrincipalId`, `actorVia` and `actorClient` only when an operator caused
them; automatic events omit the fields. `radio_leg_status` reports Palazzo's
connection and has no actor. The program's public realtime stream
(`/program/:programId/events`, unauthenticated) deliberately does not forward
the fields: `ProgramService` rebuilds each event without them, so no identity
is published to anonymous viewers.

*Known gaps.* (1) A song the rotation starts from a queue entry is not
attributed to whoever queued it: queue entries have no actor field, so that
`started` row keeps all three columns NULL (the enqueue itself is attributed
only on the `song_queue_update` event). (2) Console events on the public
`/program/:programId/events` stream do not carry the actor fields, by design
(see above); the actor is available to the as-run export and to engine-level
subscribers only.

**Export rules.** `GET /program/:programId/as-run` (permission `alcantara:radio:read`):

- `format=csv` (default) lists every record, with `inferred` (`true`/`false`),
  `reviewFlag`, `endReason`, `actorPrincipalId`, `actorVia` and `actorClient`
  columns at the end, in that order (each was appended last when added; the
  actor columns are empty for automatic rows). `format=soundexchange` keeps its
  fixed specification columns and carries no actor.
- `format=soundexchange` counts each `ended` record as one performance,
  inferred and flagged ends included, because the track was transmitted.
  `preempted` ends are the exception: they are left out of every filter.
  `inferred=include` (default) counts all ends, `inferred=only` lists only
  inferred ends (including `superseded`), and `inferred=exclude` lists only
  ends that are not inferred: Palazzo's reported ends, `stopped` and
  `replaced`. The
  two filtered exports add up to the default one. The `inferred` parameter is
  rejected with `format=csv`.

## Gapless handoff: announcing the next song

Contract: gaulatti/palazzo#40. When Palazzo accepts the active song's start in
autoplay or shuffle, segue on or off (and when a restarted backend adopts the
song Palazzo is already playing, so a restart in the middle of a song does not
cost a commanded change at its end), the engine announces the song it expects
to play next (`PUT …/playback/next`), so Palazzo fetches and queues it while
the current song plays and starts it itself at the cue-out (minus the segue's
`overlapSeconds`, under overlap). With segue on, the announcement carries the
same segue and loudness the song command would carry; with segue off, neither.

- **What is announced.** The queue head, else the playlist song the engine
  would select at the end, worked out on a copy without consuming the queue,
  moving the cursor or recording selection metrics. Selection is unchanged: at
  the end the engine selects exactly as before and promotes the announced song
  only if it is the one selected.
- **Chosen once, for the expected end, and held (2026-11-21).** The playlist
  successor is selected once, for the instant the song is expected to end
  (Palazzo's last position report, else its start plus its duration), with the
  same selection the end runs: high rotation, the similarity pick, else the
  cursor. That instant is kept with the announcement, and a refresh for the
  same song selects at it again. At the handoff the engine does not select
  again: it plays the announced song itself, promoted with no command, even
  when the song ends late or what the selection reads changed in between
  (on 2026-11-21 01:51Z a re-selection right after a restart picked another
  song and cut the announced one 0.2 s in). The held song is played only for
  the ended song's own accepted announcement and only while it is still valid
  (in the sequence with the same audio, or a catalog pick); otherwise the end
  selects anew. The selection's metrics and similarity decision are recorded
  when the held song plays, not when it is announced. A favourite that comes due between that instant and
  the real end waits for the next change. Before this, the successor was
  probed at now, the expected end, and one and ten minutes later, and left
  unannounced when the probes disagreed: with high rotation (a favourite due
  every 30 min) that was about half of all songs, and on 2026-11-21 01:13Z to
  01:30Z nothing was announced at all. A queue change, an operator pick or a
  sequence, mode or cursor change still re-announces or withdraws as below,
  and the end then follows that change.
- **Not announced** when a clocked flight log runs, the successor has an
  intro, there is no successor, the queue head is already on air, or Palazzo
  answered 404 (an older Palazzo;
  nothing more is announced to it until its boot changes). A bumper slot is
  announced only to a Palazzo that lists `next.bumper` (see below); for any
  other Palazzo the bumper slot is not announced either. Each song left
  unannounced is counted once, by reason, in
  `alcantara_radio_announcement_skipped_total{reason}`.
- **Bumper slots (gaulatti/alcantara#232, contract gaulatti/palazzo#50).**
  Bumpers stay Alcantara's: every `bumperInterval` songs, a spot from
  `bumperInstantIds`, sequential or random. When the end of the song on air is
  a slot and Palazzo's state lists `next.bumper` in `capabilities`, the engine
  chooses the spot once for that song and announces the successor with
  `bumper: {playbackId, url}`. Palazzo then plays the spot when the song ends,
  and the announced song at the spot's own end: there is no fixed wait and no
  song command, and the handoff counts as `preloaded`.
  - The spot sequence advances when the slot is used, and only for the ended
    song's own announcement: an accepted announcement for any other song never
    suppresses the slot.
  - While an announced spot is on air (its `instant.started` seen, no
    `instant.ended` yet), the no-playback watchdog (#230) counts it as
    playback, for at most 75 s (`ANNOUNCED_SPOT_PLAYBACK_MS`; Palazzo cuts a
    spot at 60 s). So a spot of 46–60 s is never mistaken for silence, and the
    engine sends nothing over it.
  - The spot counts as `sent` at the end and as `played` on Palazzo's
    `instant.started` for its playback ID. The log line is `Bumper played:
    <name> on <program>`.
  - A Palazzo without the capability, a refused announcement, or a slot whose
    spot has no audio keeps today's path. The spot plays after the end, the
    engine waits 8 s, then commands the song. That spot counts under
    `path="command"`, played on its `instant.started` when Palazzo journals
    instants. It is logged (`Bumper: <name> on <program>`) and counted `sent`
    only once Palazzo took it. A spot Palazzo did not take (for example while
    Palazzo restarts) is logged `Bumper failed: …`, counted `failed`, and the
    song is commanded at once with no 8 s wait.
  - The silence at a bumper change is read on Palazzo, in
    `palazzo_song_change_gap_seconds{handoff="bumper"}`. A 409, 400 or 422 answer, or a `playout.next_withdrawn` with reason
  `not_ready` before the end, leaves the next song to today's song command.
- **Re-announced or withdrawn** (`DELETE …/playback/next`) whenever the
  successor changes while the song plays: queue enqueue, removal or reorder,
  a sequence, mode or cursor change. If a re-announcement is refused (422,
  409, 400 or a request failure), Palazzo keeps the previous announcement
  queued, so the engine withdraws it at once rather than let it play and be
  preempted at the handoff. If Palazzo answers that it was too late (its gate
  already opened, `withdrawn: false`), the engine keeps it known: its start is
  recorded and the handoff commands the selected song and records the
  announced one as `preempted`. Once an announced song has started, nothing is
  re-announced.
- **`preempted` in the as-run log** names an announced song Palazzo started
  that the engine replaced at the handoff; it is recorded and never counted in
  any SoundExchange filter.
- **At the end.** If the announced song was accepted and is still the one
  selected, it becomes the active song, consuming the queue entry or advancing
  the cursor as before, and no song command is sent. Otherwise the selected
  song is commanded at once; an announced song Palazzo may already have started
  is flushed by that command and recorded as `preempted`. If a `not_ready`
  withdrawal arrives after promotion and the song never started, it is
  commanded at once.
- **Operator commands** (manual pick, Stop, taking another song on air) are
  today's commands; Palazzo flushes the announced song with them and the engine
  forgets it. An announced song that had already started under overlap is
  closed like the current song (`replaced` or `stopped`).
- **Events.** Without overlap Palazzo sends the current song's `track.ended`,
  then the next song's `track.started`; with overlap the next song's start
  comes first. The engine accepts the announced song's start while the current
  song is still active, so every song still has one start and one end. If its
  start event is missing but a playing snapshot reports it, that snapshot is its
  start, recorded as inferred at Palazzo's reported start time, as on adoption.
- **Metrics.** `alcantara_radio_next_announcements_total{result}` and
  `alcantara_radio_handoffs_total{path}`; see
  [radio-telemetry.md](radio-telemetry.md).
