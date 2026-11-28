# Radio station workflow

## Library tags and the on-air log

The base playout is a **continuous filler rotation**, shown in the Radio desk with its saved songs, existing queued overrides, actual engine feedback, and Manual/Autoplay/Shuffle/Loop controls. Loop with Autoplay or Shuffle runs indefinitely: no hourly schedule is required. Opening the desk never writes the sequence or sends a playback command. A future timed block does not hide or take ownership of the current rotation. The on-air strip at the top of the desk is the sole now-playing display.

**Shuffle** does not reorder the rows. It saves a separate `shuffleOrder` (item ids, the song on air first) beside the unchanged `items`, and sets the mode to `shuffle`. The engine, the desk's next song and its previous/next controls walk that order: every song once before any repeats (with loop off it ends there; with loop on the same order starts again), picking up after the cursor following a restart. A song added while shuffling plays after the order. Manual and Autoplay ignore `shuffleOrder`, so they play the operator's rows. The console writes `shuffleOrder` only when the backend's audio-bus load says `shuffleKeepsRows`; against a backend that does not (a deploy where the console arrived first) Shuffle reorders the rows as before, so it never shows a shuffle that is not playing. A rotation already in shuffle without a `shuffleOrder` (saved before gaulatti/alcantara#834) plays its rows until Shuffle is pressed again. High rotation and similarity selection are unchanged. `alcantara_radio_shuffle_picks_total{order="shuffled"|"rows"}` counts cursor picks made in shuffle.

**A restart that outlasts the song.** At start-up the engine reads what the as-run log last saw start. If Palazzo is then idle and the rotation's cursor is still on that song, the song has aired: the rotation takes its successor instead of sending it again, and a rotation that does not loop with nothing after it ends (gaulatti/alcantara#849). A song Palazzo is still playing is adopted as before, and a cursor song with no recorded start is sent once. `recordTrackTransition` counts `aired-cursor-passed`.

**A takeover between two songs.** A deploy's handover can land after the previous backend's song ended and before the next it announced starts (a spot can be on air in front of it), so the new backend finds Palazzo idle while that next is still queued in the same Palazzo process. Commanding the rotation then put a second song behind it. On 2026-11-28 at 07:07 the previous backend's next had already started and played out in full, while the new backend believed its own command was on air: Palazzo's reports matched nothing, telemetry read as stale, nothing reached the as-run, and no next song was chosen. Before it starts the rotation, the new backend now withdraws that next (`DELETE …/playback/next`) and commands nothing until Palazzo answers. Palazzo's state names no next song, so the answer is what tells the two cases apart:
- **An operator acted before the answer** (a take, a command or a Stop): nothing more is done, and the operator's action stands.
- **Withdrawn:** it was only queued. The rotation starts as before.
- **Not withdrawn:** its gate is open. Palazzo started it, a withdrawal no longer stops it, and its track start can follow seconds later. If the rotation and the queue are unchanged since the takeover and it is still valid (a playlist song with the same audio, or the Play Next request at the head of the queue), it is adopted as the song on air, as at a handoff. No command is sent, the cursor or the queue moves to it, and its start, end and as-run match. When it ends, the rotation goes on from it.
- **Not withdrawn, and it cannot be adopted** (the rotation or queue changed, or the song is no longer in it): it is followed as a foreign track. Nothing is commanded over it; its end reads Palazzo's state and resumes the rotation, so a request queued meanwhile airs next.
- **No answer:** the rotation starts as before.

The previous backend's announcement is judged at the first reconciled snapshot only (playing, foreign or idle), so a later idle snapshot never withdraws or adopts it. One exception keeps a takeover while a song plays unchanged: when Palazzo plays the song the announcement follows, the record is kept until that song is adopted. A catalogue song is recognised asynchronously, and the adoption takes the announcement as before.

A scheduled block that starts before Palazzo answers owns the audio, as an operator's action does: nothing more is done.

Known residual, accepted on 2026-11-28 (corrected after review): Palazzo also refuses a withdrawal when it holds nothing. At the first snapshot that means the announced next already played and ended, or the previous backend withdrew it without clearing its stored record. An adopted or followed song then never starts. The watchdog's no-playback bound (`NO_PLAYBACK_BOUND_MS`, 45 s) resolves it: it reads Palazzo's state, the idle state ends the adopted song, or clears the followed one, and the rotation advances. Before the first-snapshot rule, a takeover during a foreign track left the record for a much later idle snapshot (review probe P6); that route is now closed.

A takeover while a song plays is unchanged; the held announcement is kept as before.

**A playback this backend did not issue.** Palazzo can report a start or a position for a playback this backend never sent, announced, adopted or ended, while the song the backend holds as on air has had no report of its own. That means something else is on the air, unseen. On 2026-11-28 at 07:07 the previous backend's next song aired for 3.5 minutes that way, and every report was dropped without a word. The backend now logs a warning once per such playback and reads Palazzo's state. Only a playing track is reconciled, as on any resync: it is adopted as the song on air, and the unconfirmed one is closed as superseded. An idle read changes nothing: the foreign track may have ended while an operator's take has not started yet, and the take is never ended or commanded over. Only Palazzo playing the active song itself, or a track the backend never issued, is reconciled; a late read naming one of the backend's own earlier songs changes nothing. A failed read changes nothing either. Reports for the backend's own playbacks, such as the previous song's last positions while the next waits for its start, never trigger it. `alcantara_radio_engine_resyncs_total{trigger="unissued_playback"}` counts it.

**An active song gone stale.** When the song the backend holds as on air has had no Palazzo report for 15 s (since its last report, or since it was commanded) while Palazzo's telemetry reads connected, the reports are reaching it for something else, or not at all. The watchdog's 10 s tick says so once per song and reads Palazzo's state by the same rule: Palazzo playing the active song takes its missed start, an unissued track playing is adopted, and anything else (idle, one of the backend's own earlier songs, or a failed read) changes nothing. Nothing runs while Palazzo is not connected, or once this backend no longer holds the playout lease. `alcantara_radio_engine_resyncs_total{trigger="stale_active"}` counts it.

**The announced next on air, unseen.** Palazzo can move to the next song the backend announced while both the active song's end and the next's start are lost. When either read above (an unissued playback or a stale active song) finds Palazzo playing that announced next, and the active song is still the one it follows, the backend handles it like a seen handoff. It records the next's start from Palazzo's state and ends the active song as at an idle read. The handoff then promotes the announced song, which has already started, so nothing is commanded, and the rotation goes on from it. An operator's take replaces the active song, so a take never matches, and a stale read naming the announced next leaves the take alone.

**Rundown** manages optional timed content blocks. Its persistent continuous-fillers summary links directly to the rotation and live controls. Blocks are not one-hour containers: choose any start minute, use fixed offsets beyond an hour if needed, and finish after the last content event. Do not create 24 copies of a rotation to cover a day.

Scheduled content takes temporary ownership of audio without overwriting the persisted rotation or its queue. At normal completion, the backend persists the next rotation cursor while the block still owns audio, stops the block, then asks the existing engine to continue. Manual mode and a finished non-looped rotation do not start automatically. A cut filler is not resumed halfway through; the next continuous selection starts. Upcoming fixed events cut the preceding audio on time. An explicit Stop within a block keeps silence until its next event. A final Stop finishes the block and returns to automatic continuous fillers. Resume persistence failures emit `radio_rotation_resume_failed` and increment a bounded failure result. An operator Stop or failed cue does not call the completion resume path.

## Library tags

Build from tags previews concrete enabled catalog songs for a timed block, with artist separation and preference for songs used least recently in the previous 24 published blocks. Review, Save, then Publish. Preview generation never persists or publishes automatically; saved songs remain concrete selections when tags change later. `POST /program/:programId/flight/:sequenceId/generate` requires `flight.manage` and `{revision,rules:{slots:[{labelId,count,clockOffsetSeconds?}],artistSeparation}}`. It accepts only an unaired unpublished draft and returns `{items}`. Insufficient songs, deleted tags, invalid offsets, and stale revisions are explicit errors.

## Scheduled rundowns

Radio and Simulcast shows use **Rundown** at `/flight`. An operator creates a future local start time, drags catalog songs, audio clips, or a stop cue from the library onto the timeline, and optionally fixes a start by dragging its pin on the ruler (5 s steps) or typing a clock time, a +mm:ss offset or seconds from the scheduled time (see [operator-interface.md](operator-interface.md#scheduled-rundown-workspace)). The first item starts at zero. Unfixed items follow the previous song's confirmed Palazzo end event. A fixed start cuts to that item at its clock position. Logs cannot loop. The save path the console and MCP share also enforces the desk's fixed-start window (#788): when the cues or the start are written, a fixed start 6 hours or more after the block start, or at or after the next scheduled block of the show, is refused with 400 (`A fixed start at +20:00 is after the next block starts at <UTC time>.`, `… is more than 6 hours after this block starts at <UTC time>.`). A block saved before the rule still loads and can be renamed.

Save keeps the log a draft. **Check** validates cue shape and referenced enabled audio. **Publish** repeats validation and marks the block for automatic start. The backend claims a published block once when its time arrives; a failed start is visible through the `radio_log_start_failed` event and is not retried automatically after an ambiguous failure. The planner and Radio desk show the current and next items. On-air and already played items are locked; stopped/previously aired logs cannot be rewritten, and published blocks cannot be rescheduled. Future items can be changed with an optimistic revision check. Cue execution and edits are serialized per program, and fixed-time timers are rebound to cue IDs after an edit. A log cannot be published for a past start time. Scheduled logs require the backend process to be running when the block begins. If the process is down beyond five seconds after the block, the log is not started late.

The existing `/program/:programId/flight` list, create, update, activate, and start APIs carry the additive `scheduledAt`, `publishedAt`, `lastStartedAt`, and `revision` fields. `GET .../flight/:sequenceId/preflight` returns `{ready,issues,warnings,engine}`: issues block a start, warnings never do (a playable song of unknown duration, so the block's later times are estimates; or the show's radio not set up or off). Additive `issueEvents` and `warningEvents` hold one entry per issue and per warning, in the same order: `{item, name, reason}` for the event it is about (`item` is 1-based; `name` is the cue's label, else its song title or clip name), or `null` for one about the whole block. The desk shows a line as `name: reason`, and falls back to the string when the entry is null or absent (an older backend). The strings are unchanged. `engine` is `ready`, `not-configured` (no radio settings or no Palazzo URL), `disabled` (radio off in its settings) or `not-radio`; it is display only, and what starts and airs is unchanged. A `scheduledAt` that is not a whole minute in UTC ISO form is refused with "scheduledAt must be a whole minute, ISO time"; `POST .../publish` accepts `{revision}`. Program `flight.read` and `flight.manage` permissions remain in force.

## Dayparts and clocks

A **clock** is a stored set of radio log rules (tagged music blocks and an artist separation). The **grid** is one
program's week in one IANA time zone: each daypart is a day, the hours `[startHour, endHour)`, a clock and a start of
`soft` or `hard`. Both are edited on the console's **Dayparts** page, through `/program/:programId/radio-clocks` and
`/program/:programId/radio-dayparts`, or over MCP. With an empty grid nothing is generated and nothing changes.

**Filling.** The instance that runs the rundown looks once a minute at the hours that begin in the next two. For each
grid hour with no log it creates one from the hour's clock with the log generator and publishes it, through the same
checks an operator's log passes. A log a person made at that hour wins. A block the planner made is taken back when
the grid stops asking for it, unless it has started, been edited or been loaded into the rundown. A clock that cannot
fill an hour leaves a draft marked `failed`, retried each minute; the hour is left to the rotation. Changing a
clock's rules does not remake hours already made.

**Starting.** A block made from a clock starts only while the rotation is Autoplay or Shuffle and the engine is not
frozen; otherwise it is marked `skipped` and never starts. With a `soft` start the song on air finishes and its end
starts the block; the announced next song is withdrawn, and a song still on air six minutes after the hour is cut. A
`hard` start cuts at the hour, as a log published by a person does. Fixed offsets inside a clock are always hard. A
block shorter than its hour hands back to the rotation; a longer one is replaced by the next block under the same
start rule, and what had not aired does not air.

Skipped and failed hours show as a dot beside the block on the Dayparts page.
`alcantara_radio_daypart_blocks_total{result}` counts `generated`, `failed` (an hour starting to fail, or a grid
read that failed), `removed`, `started` and `skipped`.

Separation rules between songs across blocks beyond the generator's artist separation are not part of this.

## Song similarity selection

By default the continuous rotation follows its saved order. A station can opt in to choosing the next playlist song by audio similarity (`off`, `shadow` or `on`; default `off`, which changes nothing). It applies only where the engine picks the next playlist song: queued songs, manual songs, timed blocks and the high-rotation quota keep their precedence, and favorites are never ranked. When no song qualifies the engine falls back to the saved order. See [song-similarity.md](song-similarity.md) for the model, artist cycle, fallback rules and how to run the analysis.

## Playout segues and loudness normalization

Radio settings created from now on have segue-aware and loudness-normalized playout on (`segueMode: 'on'`). A station can turn it off by setting `segueMode` to `'off'` in `RadioSettings`, which sends unchanged payloads to Palazzo. Settings saved before this default changed were turned on by migration `20261120000000_radio_segue_mode_on_for_existing`, which keeps each program's previous value in `segueModeBeforeDefaultOn` (see [program-playout.md](program-playout.md)). To turn it off for one program, send `PUT /radio/:programId/settings` with `{"segueMode": "off"}`. When on and media asset analysis is present, Alcantara embeds measured `segue` (cue-in, cue-out, fade, overlap) and `loudness` (integrated LUFS, true peak) into the playout song command according to the specification in [program-playout.md](program-playout.md). If analysis is absent or marked failed, song playback continues uninterrupted with default parameters. The analysis is written by the media analysis job described in [media-library-architecture.md](media-library-architecture.md#audio-analysis).

## Voice tracks

Use **Voice** on a song row to record a link with the browser microphone. Preview the take alone or over the chosen song, set duck and fade values, then **Use this take**. The recording uploads as a managed audio clip and is attached to that exact cue by `voiceTrackInstantId`; changing another play of the same song does not change this cue. Palazzo receives the voice clip with the song command and applies the saved duck/fades. Browser preview approximates the mix. A missing or disabled clip fails preflight; if it disappears between preflight and playout, the Radio desk shows intro degradation.

## Take and start while the engine is off

A radio-only program plays only through its playout engine (gaulatti/alcantara#609). While
that engine is disabled in radio settings, or the program has no radio settings, an operator's
take or start is refused before anything is saved:

- `POST /radio/:programId/song` (Take, play now);
- `PUT /program/:programId/audio-bus` when the write would start a song (a different song
  becomes active, or an idle manual rotation switches to Autoplay or Shuffle).

Both answer `409` with `{"statusCode":409,"error":"Conflict","reason":"engine_unavailable",
"message":"The radio engine is off (disabled in settings), so nothing was taken."}`. Their MCP
capabilities, `radio_play_song` and `program_update_program_audio_bus_by_id`, run the same check
and answer `conflict`. Rotation
edits that start nothing, and stopping, still save. TV and simulcast programs are not affected:
their program output plays songs itself.

Rundown automation follows the same rule. When a scheduled or running rundown reaches a song for a
radio-only program whose engine is off, the song is not started (no audio-bus write, no engine
take). The as-run gets a row with `state: "not-aired"` and `endReason: "engine_unavailable"`. The
block is then stopped and `radio_log_cue_failed` is broadcast with `reason: "engine_unavailable"`,
so it does not run silently. The CSV export lists `not-aired` rows; the SoundExchange export and the
royalty summary read only `ended` rows, so a song that was not aired is never reported as played.

A `not-aired` row written for a rundown cue also names that rundown and cue (`flightSequenceId`,
`flightCueId`; #726). `GET /program/:programId/flight` answers each rundown with `cueOutcomes`, a list of
`{ cueId, state: "not-aired", reason }` read from those rows (an empty list when none), so the on-air
rundown shows such a cue as **Skipped** with its reason instead of Played. Older rows have neither
field and appear in no rundown's outcomes.

## Output confidence and recovery

The Radio desk separates **Stream verified** (Liquidsoap and Icecast transport) from output confidence. It shows fresh sampled output as detected, checking, silent after ten seconds below 0.001 RMS while song playback is expected, idle, unavailable, or unverified. A sample older than fifteen seconds cannot prove audio. This is a level check, not a listener-side measurement.

**Dead air** (#694): while output confidence reads silent, the on-air strip leads with a **Dead air** chip and the
Output confidence alarm names the next step. Because Palazzo's local playlist plays only when the live song queue
runs dry, the silent song comes off air first: hold Stop, then **Start with fallback** when a recovery playlist is
prepared (**Go to recovery** opens Recovery & session), or **Prepare a recovery playlist** when none is. When one
is already bound, it plays once the queue runs dry. While the recovery status is unknown or the engine is
unavailable, the alarm says to take the silent song off air and check the engine, and claims nothing about a
playlist. When the desk itself silenced the song, the alarm says so first: with the Music channel muted it reads
"Music is muted on this desk" with **Unmute music**, and with the Music or Output fader at zero it names the fader to
raise, never "hold Stop", which would leave the silence on air. The `state=radio-dead-air` fixture shows this state.

### Dead-air watchdog (unattended station)

For a station nobody is watching (overnight shuffle), the backend recovers from dead air by itself
(`backend/src/radio/dead-air-watchdog.service.ts`). It is always on; there is no flag.

- **When it acts.** Output confidence must read silent while audio is expected, and the quiet must have lasted
  **20 s** (`DEAD_AIR_ACT_MS`). Real playout has much shorter quiet runs: on 2026-11-27, 57 song changes over four
  hours all had gaps of 0.5 s or less, and a 6-minute sample at 2 Hz never stayed below 0.001 RMS for more than
  1.0 s. That makes 20 s twenty times the longest real quiet. A pass runs every 5 s, on the instance that holds the
  playout lease.
- **Steps, smallest first, each judged 20 s after its song actually started** (`DEAD_AIR_STEP_WAIT_MS`; from the
  command when the song never starts):
  1. **Play again.** The same song is played again from its start, through the engine's take path; the rotation keeps
     its mode and cursor. A song is played again at most once. Play Next entries and catalog picks are never played
     again, so they go straight to step 2.
  2. **Next song.** The silent song is ended as at a natural end. The announced successor that Palazzo never started
     is let go, so the next song's command is sent and the rotation keeps its mode. This is never the operator's Stop,
     which would turn the rotation manual.
  3. **Give up.** The desk's Dead air advice leads with "Dead air: could not recover" in bold red. The backend logs
     `DEAD AIR on <program>: could not recover` as an error, with the steps it took, and `alcantara_radio_dead_air_unrecovered_programs`
     counts the program. Nothing more is tried until the radio is heard again.
- **Cap.** At most **3 episodes per program per rolling hour**. A fourth goes straight to giving up.
- **Never acts, and holds instead.** Every guard is read fresh just before each step, and a reading it cannot make
  holds. It holds:
  - while this instance is a standby (a deploy's handover);
  - unless the rotation is autoplay or shuffle and not frozen. The operator's Stop turns it manual, so an explicit stop
    is never undone;
  - while the engine is unreconciled, a command or transition is pending, a spot or intro is on air, or a clocked log
    runs the air;
  - while Palazzo's state cannot be read, Palazzo reports itself degraded or idle, or plays another track;
  - while Palazzo's live input is on air, or Palazzo does not report it (unknown is never off);
  - while a guest is cued live, a host microphone is published, or calls cannot be read;
  - while the mixer has the music muted or the Music or Output fader at zero. The mixer is the operator's choice:
    the desk explains it and the watchdog never touches it;
  - when output confidence is unknown or unavailable (stale samples, Liquidsoap disconnected, Palazzo unreachable).
    That is a lost reading, not dead air, and the engine's nothing-on-air watchdog (45 s) keeps its own job.

  The desk shows what holds it ("Automatic recovery is waiting: a guest is cued live.").
- **What it never does.** It never touches the mixer, prepares or starts the recovery playlist, stops the session,
  withdraws a Play Next entry, or acts on a TV program.
- **The log line before an act.** Before every on-air action it logs one warning with what it saw, so a bad act can be
  explained afterwards, for example `Dead air on <program>: resend (quiet_for_ms=24000, lease=active, mode=shuffle,
  live_on_air=false, guests_live=0, host_mics=0, mixer=ok, request=<playback id>, guards=ok)`. A hold is logged once
  per reason per episode, with the same fields.
- **As-run.** A play the watchdog played again or moved past ends with end reason `dead_air`. It aired until it fell
  silent, so it still counts as a performance, as a stop does.
- **Where operators see it.** `GET /radio/:programId/output-confidence` and the MCP read tools' `output_confidence`
  carry the episode as `deadAir` / `dead_air`: `step` (`resend`, `advance`, `give_up` or null), `gaveUp`, `held` (the
  guard) and `since`. It is null when there is no episode. The `state=radio-dead-air-recovering` and
  `state=radio-dead-air-gave-up` fixtures show the desk's two states.
- **Local walk.** [Fake Palazzo](fake-palazzo.md), "A dead-air watchdog walk".

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

Radio distribution contains **Prepared local playlist**. Choose one to 100 enabled songs from the managed S3 media bucket and prepare them. Alcantara reads each exact catalog URL to calculate SHA-256, then calls Palazzo's private filler preparation API with the same URL and checksum. Palazzo downloads, verifies, normalizes, and stores the version locally. The version and selected song IDs are saved only after Palazzo reports ready. Preparing a new version does not replace the active one. The Radio desk's **Start with fallback** binds the prepared version to a new Palazzo automation session; **Stop session** clears program audio and the binding, so it acts only when held for 0.6 seconds, like Stop and Stop all; a click only explains (#693). Palazzo's local playlist plays when its live song queue runs dry. Start/stop use Palazzo's monotonic command sequence and idempotency key. If Palazzo is unreachable, controls show an error and do not claim recovery is active. Once a program radio filler is configured ([`program-filler.md`](program-filler.md)), preparation through this panel is refused and **Start with fallback** binds that configured version instead.

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
`alcantara_radio_operator_change_records_total{result="recorded|failed"}` counts the operator change records of radio settings writes (who changed them; see `docs/mcp-capabilities.md`, "Operator change records"); a failed record never fails the write.
It is exposed through the same authenticated private `/metrics` boundary and
contains no URL or station labels. Updating only the listener URL does not
reconnect Palazzo telemetry. The nullable database column is additive; reverting
application code safely leaves it unused without removing station data.

The authenticated private `/metrics` endpoint includes `alcantara_radio_log_transitions_total{result}` with bounded `interrupted`, `completed`, `unended-closed` and `unended-close-failed` (#241), `record-failed` (#256: a play's started or ended as-run row was lost after three retries; the writer retries a failed write after 250, 500 and 1000 ms, per program in arrival order, and the writes are idempotent), `resume-failed`, `filled`, `fill-failed`, `generated`, `generation-failed`, `edited`, `edit-failed`, `published`, `started`, `start-failed`, `cue-failed`, `cue-retried` and `cue-skipped` (#719, below), `preflight-failed`, and `poll-failed` results; `alcantara_radio_output_confidence_transitions_total{state}` with bounded confidence states; `alcantara_radio_output_silent_programs`; `alcantara_radio_dead_air_steps_total{step,result}`, with `step` one of
`resend`, `advance` or `give_up` and `result` one of `recovered` (heard again after the step), `still_silent` (the
next step was needed) or `held` (a guard held the step, counted once per reason per episode), every pair exposed from
zero; `alcantara_radio_dead_air_unrecovered_programs` (programs the watchdog gave up on, until they are heard again);
`alcantara_radio_recovery_preparations_total{result}` with bounded `ready` and `failed` results; and the existing Palazzo request/retry metrics with `filler-prepare` and `automation-*` operations. No program, song, URL, version, or error text appears in metric labels. The Radio desk shows active and upcoming log state and recovery readiness; inspect Palazzo's filler metrics and lifecycle state for its local playback and preparation details.

### Timed-block cues during an engine outage (#719)

A timed-block cue that fails while the automation engine is unavailable (the song engine has frozen the program on a Palazzo `unavailable`, `instance-mismatch` or `instance-conflict` status) does not stop the block. The cue is held:

- When the engine is back within 60 seconds (`ENGINE_OUTAGE_GRACE_MS`) of the cue's due time, the cue is retried once. When it then plays, `cue-retried` is counted and the block goes on as usual. A fixed-time cue's due time is its clock time; a cue without one counts from when it first failed.
- Past the grace, the cue is skipped and `cue-skipped` is counted. A skipped song writes a `not-aired` as-run row with end reason `engine_unavailable` (#715) that names its rundown and cue, so the on-air rundown shows it as **SKIPPED** (#726). The desk shows "A timed cue was skipped", and the block runs the next cue.
- A fixed start that arrives while earlier cues have not played jumps over them: the fixed cue starts on time, each cue passed over counts `cue-skipped` and is broadcast as skipped, and each song among them writes a `not-aired` as-run row with end reason `fixed_start` naming its rundown and cue, so the rundown shows it as **SKIPPED** ("not aired, cut by a fixed start") instead of played. Not-aired rows are never counted as performances. The song the fixed start cuts ends with end reason `fixed_start` rather than `stopped`; it aired until then, so it still counts as a performance.

**When the playout engine restarts under a song.** Palazzo comes back under a new boot ID and no longer plays that song. If more than 10 s of it were left at Palazzo's last report, the as-run log closes it at that moment with end reason `playout_restart` (inferred, still counted as a performance: it aired up to the cut), the radio desk says **Playout restarted: song cut at m:ss**, and the rotation goes on with the next song. It is not resumed: Palazzo ignores a head trim over 10 s, so a file cannot be started part-way (gaulatti/palazzo#74). 

**When the backend restarts with it** (a host reboot, a Docker restart): the engine stores what Palazzo last reported hearing, with Palazzo's boot ID, about every 5 s. On its first report from Palazzo once it has taken up the rotation (if one arrived earlier, it reads Palazzo again at once), a different boot ID, a stored song with more than 15 s left and an as-run start with no end give the same `playout_restart` row, at the stored time, and the desk is told when it connects (for 10 minutes). The position is then up to 5 s earlier than what was heard. If the backend stopped first and Palazzo was restarted later on its own, the song is still recorded as cut where it was last heard.
- A retry that fails again stays held until the same deadline. A cue failure while the engine is up still stops the block (`cue-failed`), as before.


## Rundown shadow (#123)

The pure resolver (`backend/src/program/flight-resolver.ts`, #152) computes, from a sequence, the time it started and
the time now, what should be on air. It does not drive anything yet. The executor compares it with what is on air,
as an observation only (`backend/src/program/flight-shadow.ts`).

**When it compares.** Each time a manually started sequence begins a wait: a `wait` of at least 200 ms, or a
`waitForSongEnd`.

**What it compares.**
- **Cue:** the cue the executor waits on, against the cue the resolver says is in effect.
- **Scene:** the program's scene on Program, against the resolver's.
- **Song:** the song the playout engine has confirmed on air, against the resolver's. Until the rundown has sent a
  song of its own, the song on air is another source's (a rotation's), so it is counted as `unsupported` and never
  logged. It is not compared at the first wait after a song cue, since the engine confirms a song a moment after it
  is sent.

**What it does not compare.**
- **Runs the resolver does not model:** a clocked log, a run an operator advanced with Go, a wait for a song end that
  timed out, or a run whose scene could not be read. Each is counted once as `unsupported`, and nothing is compared
  after it.
- **Nothing on air changes:** the comparison arms no timer and is never awaited by the run.

`alcantara_rundown_shadow_total{field,result}` counts the comparisons:
- `field` is `cue`, `scene` or `song`;
- `result` is `agree`, `disagree` or `unsupported`;
- every series is exposed from zero.

A disagreement is logged as `Rundown shadow disagrees on <field> for program <id>, sequence <n>, cue <cueId>`, with ids
only.

## Fillers between timed blocks

Build and review content first, then select its filler tag and artist separation in **Fill the gaps**. `POST /program/:programId/flight/:sequenceId/fill` requires `flight.manage` and `{revision,items,rules:{labelId,artistSeparation}}`, and returns a preview `{items,warnings}`. The input includes the current reviewed draft, including unsaved content. The endpoint accepts only unaired unpublished scheduled drafts, checks program scope and revision, and does not save or publish.

The preview preserves content cue IDs and fixed starts, replaces only previously generated fillers, and materializes catalog song IDs for every gap to the next explicit fixed boundary. Songs already present as content are reserved and fillers do not repeat within the block. Selection favors songs used least recently in the previous 24 published blocks; whole songs that fit are preferred, otherwise the shortest eligible song covers the remaining gap and its cut is reported. Artist separation applies across content and fillers. Unknown-duration filler songs are excluded with a warning. Unknown content duration, content overrun, an insufficient tag pool, or more than 120 events fails explicitly without changing the draft.

Standalone audio clips require an accurate declared duration; scheduled execution takes music off air at clip start and waits that duration before following events. A fixed start still takes precedence. Clips use the existing shared instant-audio channel and are not forcibly stopped individually; the declared duration must cover the actual clip. Explicit Stop content leaves intentional silence rather than filling it. The preview does not add an end boundary. Add a fixed final Stop yourself when the block must finish at a precise time. Saved fillers carry `isFiller:true` through validation, storage, reload, and rendering; tags are not read during playout. Filler previews record bounded `filled` and `fill-failed` results in the existing private radio log transition metric. No database migration is required.

## What a backend deploy does to air

A backend deploy replaces the backend container. Palazzo, which puts the audio out, is not restarted.

- **Songs play through.** The song on air keeps playing. A successor Palazzo already accepted, with its jingle in a bumper slot, starts at the cue-out even while the backend is down.
- **The next song is kept.** The new backend adopts the song Palazzo is playing and keeps the next song the old one had queued there, or announces one when none was ([Gapless handoff](#gapless-handoff-announcing-the-next-song)). If Palazzo is idle instead, an Autoplay or Shuffle rotation resumes without repeating a song that already started.
- **The jingle cadence survives.** The count of songs and the next spot are stored as songs end. A song that ends while the backend is down is not counted, so a jingle can still come one song late then.
- **The desk and its tools drop for a moment.** Commands fail until the new backend answers; reload nothing, repeat the command.
- **A running timed block does not resume.** It is marked interrupted and is not replayed; the continuous rotation carries on.
- **The deploy checks the radio.** It fails if no song starts after the restart while a program is in automation (a live show passes).

Measured on 2026-11-27 between 00:00Z and 01:53Z, across ten backend deploys: 36 plays with no repeat, no missing start or end and no song cut short; every gap over 5 s was a station jingle. Before the count was stored, three of those restarts delayed a jingle by one song.

## Continuous rotation and block migration

No database migration or automatic rewriting of saved data is needed. Existing rotations remain in `ProgramState.songSequence`; scheduled song cues no longer replace them with a one-song manual sequence. Existing hourly blocks, including explicit +3600 Stop boundaries, continue to work as authored. New filler previews add songs only before an existing fixed boundary; they never invent an hourly end or append material after the last content event. Library tags remain preview selection inputs; tag edits do not silently alter persisted playout. The 120-event limit applies to an individual timed block, not to the continuous rotation or broadcast day. Fixed cue timers recheck distant boundaries in bounded timer chunks rather than overflowing the runtime timer limit.

An explicit operator Stop takes audio off air and sets the base rotation to Manual, preventing an idle telemetry snapshot from starting it again. This holds for every Stop path, including `POST /radio/:programId/song/stop`: the song engine itself turns an Autoplay or Shuffle rotation Manual and persists it, cued past the stopped song, so neither idle snapshots nor a backend restart start playback. Playback resumes only when the operator acts: Play (the rotation set back to Autoplay or Shuffle) or a manual pick. A Stop through the program can leave the rotation with no cursor (`activeItemId` null). An explicit switch into Autoplay or Shuffle with no cursor starts at the first song in the order that plays (the rows in Autoplay, `shuffleOrder` in Shuffle), for every client, which is the song the desk shows as next. Nothing else fills a missing cursor: the watchdog, a restart, a sequence update that keeps the mode, and a Loop change start nothing (walk part 5). Only operator stops halt: a stop the flight itself drives (a manual flight ending, a failed timed cue, a failed rotation resume, a rundown Stop song cue) keeps the rotation's mode and cues it past the stopped song, so it neither halts nor replays. Internal timed-block cuts preserve the rotation and cursor. A Stop, and a rotation that does not loop running out, leave the cursor on a song that has not aired; the engine marks it (`cuedItemId`), so the desk's Next, Cue next and Autoplay all name that song until it starts or the cursor moves.

On backend restart, scheduled blocks whose in-memory timers were lost are marked interrupted (`isRunning:false`) without resetting `lastStartedAt` or rewriting the rotation. They are not replayed automatically. The continuous engine retains its normal authoritative Palazzo snapshot reconciliation before sending a new selection. The bounded `interrupted` metric counts startup batches containing such blocks.

**A rundown started by hand resumes its timer** (gaulatti/alcantara#123). Radio and TV alike, only on the instance that
holds the playout lease. Each manual start records `lastStartedAt`. On start-up, for a row still marked running, the
backend computes where the rundown should be by now (`flight-resolver.ts`) and restores only the timer: a wait keeps its
original end, and a song wait also moves on as soon as the engine reports the song ended (its own fallback fires 10 s
after the song should have ended). No cue is executed and no scene or song is re-taken. When what is on Program or on
air differs from where the rundown should be (a song that should be playing but is not yet confirmed on air counts), or
the executor had not reached that cue (an operator had advanced it),
the rundown stays at its last applied cue with no timer, and the operator's next Go continues from there. A rundown past
its last cue is marked not running; so is a loop started more than one loop ago, a row with no recorded start, one with
clock-time cues, and one that is no longer the active rundown.

`alcantara_rundown_recovery_total{result}` counts each by `resumed`, `finished`, `diverged`, `skipped_unsupported` or
`failed` (the row is marked not running and only the error class is logged). No ids appear in labels.

## Deleting a program

A program that is on air is not deleted: 409 "This show is on air. Take it off air before deleting it.", by the same
check a rename makes (a scene or fade to black, a running log, a playing song or scene instant), and the delete matches
the program only while it is still off air. It is also refused, 409 "Its filler is on air. Stop it before deleting.",
while its filler is on air, by the rule a rename uses ([program-filler.md](program-filler.md)). A delete of an off-air program removes its rows, stops its song engine's
timers, any armed rundown timer and its Palazzo telemetry client, and drops what they held for it. It sends no command.

## Saving the rotation

`PUT /program/:programId/audio-bus` with a `songSequence` replaces the whole stored rotation, so a save names the
rotation it was made from. `GET /program/:programId/audio-bus`, the save's answer and the `audio_bus_update` and
snapshot messages carry `sequenceVersion`: a hash of the playlist and mode. The cursor is left out, so a song ending
does not change it. The engine also stores the mode: a Stop in autoplay or shuffle leaves it manual, which is a new
version, sent with the queue update that carries the stopped sequence. The save sends it back as `sequenceVersion`.

| The save sends | Console HTTP | MCP |
| --- | --- | --- |
| the current version | written | written |
| another version, or `null` (its load failed) | 409 | 409 |
| no version | written, unless it would cut 3 or more songs to 1 or none: 409 | 409 |

The refusal is "The rotation changed or didn't load: reload before saving". Over MCP, `get_queue` gives
`sequence_version`. A save of the mixer alone, scheduled rundown automation, leaf removal and Play Next need none.

`alcantara_song_sequence_saves_total{result}` counts operator saves: `versioned`, `unversioned`, `refused_missing`,
`refused_stale` and `refused_emptying`. The console accepts a save with no version only because the installed pilot
sends none; once the pilot is re-synced and `unversioned` stays flat, those saves will be refused too.

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

**Which song a row names.** The as-run log asks the engine which library song it
commanded, announced or adopted for the event's playback ID, and looks the audio
address (then title and artist) up only when the engine has no record: two songs
can share an address. The engine keeps the last 128 playbacks per program, in
memory, so after a backend restart the lookup applies.

**Starts adopted from a snapshot.** When the engine adopts a song from a
playing snapshot without having seen its start (for example after a backend
restart mid-song), it emits one `track.started` with `inferred: true`, at
Palazzo's reported start time (`track.startedAt`), or at the snapshot time when
the snapshot carries none. The `started` row stores `inferred = true` and no
`reviewFlag`; the play's end is then no longer flagged `no-start`. If the real
`track.started` also arrives, the unique key keeps one row.

The same applies to a song the engine commanded itself whose start event was
missed, for example one started while the event stream was reconnecting
(gaulatti/alcantara#716): the playing snapshot that names it is its start.

**Plays whose end never arrived (#241).** A song that ends while the backend
is down never delivers its `track.ended`. A restarted backend has no event
cursor, so it does not replay it, and the play would stay open forever. Once a
later play of the same program ends, every earlier play still open gets one
inferred end. That covers plays from the last 24 hours (`AS_RUN_UNENDED_LOOKBACK_MS`),
but never one that started more than an hour before this backend process
started (`AS_RUN_UNENDED_BEFORE_BOOT_MS`), so a deploy never rewrites older
history: those rows are only listed (below). Each closed play gets
(`inferred = true`, `reviewFlag = unended`) at the next play's start, the latest
moment it can have ended. That end is an upper bound on the play's air
time, which is why the row is flagged: royalty summaries should treat `unended`
rows as reviewable. It still counts as a performance: it aired. A failure while
closing never affects the real end that triggered it, nor the engine: it is
logged by its error class and counted as
`alcantara_radio_log_transitions_total{result="unended-close-failed"}`. A
crossfade is not affected, because the overlapped song always ends before the
next one does. Each close logs one warning (with the record id, never a title)
and counts `alcantara_radio_log_transitions_total{result="unended-closed"}`.

A song that came on air while another song or one of the engine's spots was still on the bus, for longer than 3 s,
has its `started` row flagged `reviewFlag = overlap` by the program bus overlap check (#242, see
`docs/radio-telemetry.md`). The play still counts; the flag says it was heard over another source.

To find rows written wrongly before this (every restart since the adoption code
landed, cac3b74), run the read-only listing against the database after
`npm run build`:

```
node scripts/list-as-run-anomalies.mjs [--since=2026-08-25T00:00:00Z] [--program=<id>]
```

It prints `unended` plays (started, never ended, while a later play did) and
`overlap` plays (started more than 15 s before the previous play's end, which is
two songs on air, as on 2026-11-21 at 08:10Z). It runs inside a read-only
transaction and writes nothing. Corrections to historic rows wait for the
owner.

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
- `not_aired`: Palazzo reported a song longer than 20 s as ended within a
  second of starting it (its own event times), so nothing of it was heard
  (gaulatti/palazzo#75). Recorded as started and not aired, never counted.

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

- Every export has a window (gaulatti/alcantara#237). `from` and `to` are
  optional ISO 8601 dates; without `from` the window is the 31 days before
  `to`, or before now when `to` is omitted too (`AS_RUN_EXPORT_DEFAULT_DAYS`).
  To export more, pass an earlier `from`. Records are read 1,000 at a time
  (`AS_RUN_PAGE_SIZE`), in time order.
- `format=csv` (default) lists every record of the window, with `inferred` (`true`/`false`),
  `reviewFlag`, `endReason`, `actorPrincipalId`, `actorVia` and `actorClient`
  columns at the end, in that order (each was appended last when added; the
  actor columns are empty for automatic rows). `format=soundexchange` keeps its
  fixed specification columns and carries no actor.
- `format=soundexchange` counts each `ended` record as one performance,
  inferred and flagged ends included, because the track was transmitted.
  `preempted` and `not_aired` ends are the exception: they are left out of every filter.
  `inferred=include` (default) counts all ends, `inferred=only` lists only
  inferred ends (including `superseded`), and `inferred=exclude` lists only
  ends that are not inferred: Palazzo's reported ends, `stopped` and
  `replaced`. The
  two filtered exports add up to the default one. The `inferred` parameter is
  rejected with `format=csv`.

## Play Next claims and playback IDs

The engine claims the Play Next head before commanding it: the entry is saved as active with a newly minted
playback ID, and that ID is the one sent to Palazzo. Palazzo's playout journal never replays a playback ID; a
command that repeats one is answered `duplicate: true` and airs nothing. So:

- **An ID is sent once per process.** The engine remembers the playback IDs it sent (the last 128). A claimed head
  under one of them (a Play Next song that aired and was cut, or a re-send that aired nothing) is dropped from the
  queue and counted as `stale-claim-dropped`, and the next queued entry plays, else an automatic rotation continues,
  else the desk stops. It is never sent again, so the watchdog cannot loop on it.
- **A claim saved before a restart is sent once.** Its command may have been lost in the restart, so the restarted
  engine sends it, as before: it airs exactly once. If it had already aired, Palazzo answers `duplicate: true` and
  nothing plays; the watchdog then finds the ID already sent and drops the entry. A `duplicate: true` answer alone
  is not a failure: the client retries a song command under the same key, so it can also mean the first attempt was
  accepted and is airing.
- **Take now and Stop give the claim back.** A Take now that replaces a Play Next song on air releases its claim
  (`preempted`), as Stop and a failed command already did; the entry stays at the head and airs again after the
  taken song, under a new playback ID.
- **A song that ends normally is consumed** as before.

Walk part 4 (2026-11-26) found the gap: after a Take now over a Play Next song, the engine re-sent the claim's ID at
the next end, Palazzo aired nothing while the desk said On air with Dead air, and every watchdog resume re-sent it.

In manual mode the watchdog otherwise never acts, so a claim restored after a restart whose command Palazzo answers as
a duplicate is judged by it until Palazzo confirms the song: after Palazzo has reported nothing on the air for the
watchdog's bound, the song is taken off air and its entry dropped, counted `restart-duplicate-dropped`. Nothing else is
started. A duplicate answer for a song Palazzo reports playing changes nothing.

## A take while Play Next is being claimed

Before it commands the Play Next head, the engine saves a claim on it. If a Take now lands while that save is in
flight, the taken song keeps the air: when the save completes, the claim is given back (counted `released`), as a
Stop gives it back, and the entry stays at the head of the queue. Before, the claim's continuation commanded the
queued song over the taken one (#814 review).

A Stop that lands while that save is in flight wins the same way: when the save completes, nothing starts, the claim
is given back (`released`), and the entry stays at the head of the queue for the operator's next start (walk part 5).

## When a rotation that does not loop runs out

At the end of the last song of an automatic rotation with Loop off, and nothing queued, the engine turns the rotation
**manual**, rewinds it to the first song, and records `endedAt`, as an operator Stop leaves it manual. The rotation
is saved and broadcast with its new version, since the mode is part of the version (#811), so the desk's next save
is not refused. `endedAt` is where the rotation stands, not an edit: it is left out of the version and is optional,
so a rotation stored without it reads as before. The end is logged once ("Rotation ended on …") and counted as
`alcantara_radio_track_transitions_total{result="rotation-ended"}`; the watchdog stands down in manual, so it no
longer logs `no_successor` every minute.

Nothing starts it again on its own: not the watchdog, not a restart, and not turning Loop on, which only decides what
happens at the end of the list. Any start clears `endedAt`: a take, or Autoplay or Shuffle, which play the rotation
from the top. The desk shows **Rotation ended** (warning) with "Nothing is scheduled" while nothing is on air;
audible output with no song commanded keeps its own label (#804). Walk part 4 found the gap.

## Gapless handoff: announcing the next song

Contract: gaulatti/palazzo#40. When Palazzo accepts the active song's start in
autoplay or shuffle, segue on or off (and when a restarted backend adopts the
song Palazzo is already playing, so a restart in the middle of a song does not
cost a commanded change at its end), the engine announces the song it expects
to play next (`PUT …/playback/next`), so Palazzo fetches and queues it while
the current song plays and starts it itself at the cue-out (minus the segue's
`overlapSeconds`, under overlap). With segue on, the announcement carries the
same segue and loudness the song command would carry; with segue off, neither.

- **Kept across a backend takeover.** Palazzo drops a queued song as soon as it is given a replacement, before the
  replacement has resolved, so a replacement sent seconds before the cue-out leaves silence (2026-11-28 01:33Z: 1.9 s at
  a deploy, four seconds after the new backend took over). The accepted announcement is stored
  (`RadioPlayoutAnnounced`, one row per program, removed when nothing is queued). A backend that takes over keeps it
  when it follows the song adopted, the same Palazzo process holds it, and it can still be played (the same audio in
  the rotation, or the entry still heading the queue). It is judged again as soon as an operator changes the rotation
  or the queue, and withdrawn when nothing should follow (Manual, a clocked rundown). The similarity decision recorded
  when a held pick plays is not carried across.
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
  `bumperInstantIds`, sequential or random. The count and the next spot are
  stored as songs end (`RadioBumperPosition`) and taken up at a restart; a
  position stored for another interval or other instants is ignored and the
  count starts at zero. When the end of the song on air is
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
