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

Radio distribution contains **Prepared local playlist**. Choose one to 100 enabled songs from the managed S3 media bucket and prepare them. Alcantara reads each exact catalog URL to calculate SHA-256, then calls Palazzo's private filler preparation API with the same URL and checksum. Palazzo downloads, verifies, normalizes, and stores the version locally. The version and selected song IDs are saved only after Palazzo reports ready. Preparing a new version does not replace the active one. The Radio desk's **Start with fallback** binds the prepared version to a new Palazzo automation session; **Stop session** clears program audio and the binding. Palazzo's local playlist plays when its live song queue runs dry. Start/stop use Palazzo's monotonic command sequence and idempotency key. If Palazzo is unreachable, controls show an error and do not claim recovery is active.

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

An explicit operator Stop takes audio off air and sets the base rotation to Manual, preventing an idle telemetry snapshot from starting it again. Internal timed-block cuts preserve the rotation and cursor.

On backend restart, scheduled blocks whose in-memory timers were lost are marked interrupted (`isRunning:false`) without resetting `lastStartedAt` or rewriting the rotation. They are not replayed automatically. The continuous engine retains its normal authoritative Palazzo snapshot reconciliation before sending a new selection. The bounded `interrupted` metric counts startup batches containing such blocks.
