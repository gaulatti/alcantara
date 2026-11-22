# Media library architecture

Alcántara has one media library. Every playable or displayable file has one
canonical `MediaAsset`; its physical type, capabilities, and labels answer
different questions and must not be collapsed into one enum.

## Physical type, capability, and label

`MediaAsset.mediaType` describes the bytes: `IMAGE`, `AUDIO`, or `VIDEO`. It is
stable even when the asset gains another use.

Typed capability records describe what an asset can do. The current capability
set is instant audio, scene-background audio, song playback, and video
transition. Capabilities are additive: one audio asset may be both an instant
and a background without duplicating its file or identity. Capability-specific
data remains typed, such as instant volume, song artist and duration,
background default volume, or transition cut point.

A song's audio and cover art are two assets: the audio asset carries the song
capability, while the cover is an image asset with a derived cover capability
and a typed reference from the Song record.
The legacy `coverUrl` remains populated for radio and now-playing compatibility.

`MediaLabel` describes how operators classify media. Examples include `80s`,
`90s`, `Headlines`, `Sponsor`, and `Christmas`. A label is not a media asset or
a capability: it has no URL, codec, playback lifecycle, or enabled state. Every
asset may have zero or more labels, and `MediaAssetLabel.position` supplies a
stable order where a consumer such as a slideshow needs one.

There is deliberately no new collection table. The operator workflow is to
upload media, then apply one or more labels inline or in bulk. Every media label
selector can create a label in place; the new label is selected immediately so
the operator can finish the upload or bulk action without leaving the workflow.
The library and scene label selectors load every page of the label catalog, so
labels beyond the first 200 remain available after a refresh.
Bulk image uploads apply label assignments in order. Each backend replacement
locks the affected label before allocating its next position, so concurrent
operators cannot assign the same position to different assets. If image creation
succeeded but a label request failed, the image remains in the library; edit the
existing image and save its labels instead of uploading it again.
A slideshow selects an image label and resolves its enabled image assets in
label order.

The Media library follows the selected show's physical output. Radio shows
expose only Audio and Labels and canonicalize visual Media URLs back to Audio.
TV and Simulcast shows retain Images, Audio, Video, and Labels. Radio song cover
images remain canonical image assets and continue to appear in song and
now-playing interfaces; hiding visual library tabs does not remove or rewrite
those assets.

## Canonical identity and compatibility

`MediaAsset` owns the stable string ID, physical type, display name,
producer-supplied source URL, enabled state, and timestamps. Deterministic IDs
remain `image:<id>`, `audio-clip:<id>`, `song:<id>`, and `transition:<id>` while
the specialized tables remain in service.

Existing `Media`, `Instant`, `Song`, and `Stinger` records continue to own their
specialized contracts. Existing song IDs, playlist JSON, cursor semantics,
Palazzo request IDs, radio endpoints, and playback code are unchanged by this
migration. The common catalog reads those typed relations; it is not inserted
into the live radio execution path.

Legacy `MediaGroup` rows are imported as labels with deterministic IDs of the
form `legacy-media-group:<id>`. Writes to an imported label mirror its name,
description, ordered image membership, and deletion to the legacy tables in the
same transaction. Existing scene metadata using `mediaGroupId` therefore keeps
working while new scene edits store `labelId`. The renderer reads `labelId`
first and retains the old media-group path for scenes not yet edited.

## Migration and consistency contract

The production migration is additive: it adds the nullable physical type column and new
capability/label tables, backfills types, song-cover image assets, and legacy
group labels, and makes the old conflated `kind` nullable. It drops no table,
column, enum value, song row, playlist state, or relationship.

The physical type column remains nullable only during this compatibility phase
because the deployment migrates before stopping the previous backend. A media
upload during that overlap can still be accepted, and startup reconciliation
fills its type before the replacement backend becomes ready. A later contraction
migration can enforce the non-null constraint after old writers are retired.

All specialized create and update paths synchronize the canonical row in the
same transaction. Startup reconciliation closes the deployment overlap window,
adds background capability to instant audio referenced by scenes, mirrors
legacy groups into labels, and removes only provably orphaned compatibility
rows. Reconciliation uses a 60-second transaction budget so production-sized
catalogs can complete atomically without inheriting Prisma's five-second
interactive-transaction default. Startup fails if reconciliation fails.

Scene background selection now stores `sceneInstant.assetId` and resolves the
typed background capability directly. Existing scene metadata containing only
`sceneInstant.instantId` remains readable and playable; the control UI maps that
legacy instant to its canonical asset until the scene is edited. New
background-only uploads do not create or appear as Instant records.

The bounded `media-asset-reconciliation` job metric records success and failure
and updates the standard last-success timestamp. HTTP metrics use bounded
`media-assets` and `media-labels` route labels. Metrics never contain asset IDs,
label names, URLs, or other content.
`alcantara_media_label_assignments_total{result}` counts committed asset-label
replacements (`success`) and failed replacement transactions (`failure`). The
only other possible result is `unknown` for unrecognized instrumentation input;
no asset or label identifier appears in this metric.

## Audio analysis

Every `AUDIO` asset (songs and audio clips) is measured once per source URL by
the media analysis job in `backend/src/media-analysis/`, and the result is
stored in `MediaAssetAnalysis`, one row per asset. The job runs in the backend
process from startup; it needs no setting. Uploads, the asset record and its
capabilities are never written by the job, so an analysis failure cannot block
or undo an upload: the asset stays playable and the radio service keeps its
no-analysis path.

**How it runs.** Five minutes after startup, so a deploy's own startup never
competes with it, the job picks the newest audio asset that has no row, whose
row describes another `sourceUrl` (the file was replaced), or whose retry time
has come. It analyses one file at a time (concurrency 1) and polls once a
minute when there is nothing to do. A newly uploaded asset is therefore picked
up within about a minute, and the existing library is backfilled newest first.
Before scheduling anything the job checks that `ffmpeg` and `ffprobe` start; if
either is missing it logs `Media analysis is not scheduled` and does nothing
else.

**Throttle.** The radio backend runs around the clock, so the job keeps to a
fraction of one core:

- **Lowered priority.** At startup the job checks that `nice` can start the
  tools and then runs every `ffprobe` and `ffmpeg` as `nice -n 19`. The
  production and development images are `node:22-alpine`, whose busybox
  normally includes `nice`. The startup log says which applies: `Media
  analysis is scheduled at lowered priority`, or that `nice` is not installed
  and the job runs at normal priority.
- **Duty cycle.** After each run, whether it succeeded or failed, the job waits
  three times as long as the run took (the run includes the download), so it
  is busy at most one part in four: about a quarter of one core. The wait is
  never shorter than 5 seconds or longer than 10 minutes. These are fixed
  constants in `media-analysis.service.ts` (`DUTY_CYCLE_MULTIPLE`,
  `MIN_WAIT_MS`, `MAX_WAIT_MS`, `START_DELAY_MS`), not settings.
- **One thread.** `ffmpeg` runs with `-threads 1`.

**What it measures.** `ffprobe` reads the first audio stream's tags, and one
`ffmpeg` pass (`-threads 1`) runs `silencedetect` and `ebur128` with true peak:

| Column | Source |
| --- | --- |
| `integratedLufs` | ebur128 integrated loudness |
| `truePeakDbtp` | ebur128 true peak |
| `cueInSeconds` | end of a silence that starts the file, else null |
| `cueOutSeconds` | start of a silence that ends the file, else null |
| `isrc` | `ISRC` or `TSRC` tag, normalized (`USRC17607839`), else null |
| `musicbrainzRecordingId` | `MUSICBRAINZ_TRACKID` / `MusicBrainz Track Id` tag, else null |
| `fadeInSeconds`, `fadeOutSeconds`, `overlapSeconds` | not measured, always null |

Silence is below −50 dBFS for at least 0.5 s; a silence within 0.05 s of an
edge touches it. Continuous audio gets no cue points. A stored success always
passes the bounds the Palazzo client enforces on a song command
(`validateSongSegue` and `validateSongLoudness`), with a missing cue checked as
the file's own edge; anything else is recorded as a failure.

**States.** `pending` while a run holds the row (a ten minute lease), `success`
with the measurements, `failed` with no measurements and a bounded `error` code:
`timeout`, `unavailable`, `output-limit`, `probe-failed`, `decode-failed`,
`no-audio`, `silent`, `invalid-measurement`, `unsupported-source` (not an http
or https URL), `source-refused` (the URL carries a user name or password, does
not parse, its host is or resolves to a non-public address, it redirects, or
it answers with another content type or more than 200 MiB),
`source-unresolved` (its host did not resolve), `source-unavailable` (an error
status or a failed connection, retried) or `interrupted` (the last
run's lease ran out). Each source gets
at most three runs; a failure that can change is retried after 5 and then 30
minutes (`nextAttemptAt`), while `no-audio`, `silent`, `invalid-measurement`,
`unsupported-source` and `source-refused` are final at once. `attempts` counts runs for the
current source, and a new `sourceUrl` starts the count again. Runs are claimed
with an optimistic check on the row, so two backend instances never analyse the
same file. Re-running the job is idempotent: the same file produces the same
row.

**Limits.** Each file has 180 seconds for the fetch, the probe and the
measurement together, and a tool that writes more than 4 MiB of output is
stopped. A remote source is fetched under the outbound-request policy
([outbound-requests.md](outbound-requests.md)): every address its host
resolves to must be public, the connection goes to the checked address, no
redirect is followed, the answer must be audio and at most 200 MiB (the upload
limit). The body is streamed into a private temporary file that both tools
read with `-protocol_whitelist file`, and it is removed after every run. The
managed media bucket and its CDN are public, so they pass. Neither the source
URL nor tool output is logged or stored; a failure logs
`media_analysis.failed` with the asset ID, result and code.

**Cost.** On the fixture used for the ticket (a 4 minute, 320 kbps stereo MP3
read from local disk, Apple M-series), one analysis takes about 1.5 s wall and
1.65 s CPU, with about 22 MB resident. With the duty cycle each track then
takes about 1.5 s plus the 5 s minimum wait, so a 5,000-track library takes
about 9 hours. If a production run takes 4 s including the download, each
track takes 4 s + 12 s and the backfill about 22 hours. Either way the job is
busy at most a quarter of the time.

**Metrics.** `alcantara_media_analyses_total{result}` and
`alcantara_media_analysis_duration_seconds{result}`, where `result` is
`success`, `retry` (failed, scheduled again) or `failure` (failed for good).
`alcantara_media_analysis_backlog_assets` (no labels) is the number of audio
assets still waiting at the last poll: unanalysed, stale, or due a retry. It
falls to zero when the backfill is done.
`alcantara_media_analysis_result_writes_total{outcome}` counts finished
analyses whose result write the database refused (see below): `retried` (held
for another run), `stored_after_retry`, `released` or `dropped`.

**A refused result write (#278).** The asset is claimed (attempt n, a ten
minute lease), analysed, and then the result is written. If that write fails on
a transient database error (a timeout, a dropped connection), the finished
measurement is kept in memory and the next runs store it before any other asset
is taken, so ffmpeg does not run again and the attempt is not spent twice. Each
retry is one duty-cycle run, at most `MAX_WRITE_RETRIES` (3) of them. If they
all fail, the claim is released with the attempts the asset had before the run
(the lost write is not an attempt) and a wait of the first retry backoff (5
minutes), so a database that keeps refusing the write does not starve the other
assets; if even the release fails, the lease runs out as it always did. A
warning with the cause class is logged at each step, never the message. A write
that fails for any other reason is logged as an error and not retried. The held
result is lost on a restart; the lease path then applies, as before.

**Rollback.** A forward fix. The job only writes `MediaAssetAnalysis`, which
playback reads only for programs with `segueMode` `on`.

## Authorization and public rendering

The unified catalog filters each result through the existing per-capability
read permission. Managing labels on an asset requires management permission for
that asset's capability; one audio permission does not grant mutation rights to
all audio. Label creation and metadata changes require at least one existing
media-management permission.

Program output can resolve only a label's ordered, enabled image URLs through a
read-only public rendering endpoint, matching the prior public slideshow-group
contract. Administrative label and asset APIs remain authenticated.

## Deployment and rollback

Deployment may briefly restart Alcántara while migrations run. After restart,
the persisted radio playlist and playback behavior must be identical: no queue
reset, cursor loss, ordering change, skipped track, or altered Manual, Autoplay,
Shuffle, Loop, intro, or Palazzo behavior is acceptable.

Rollback is code-compatible during this phase because the previous application
ignores the additive tables and column. The pre-change logical database backup
is the database rollback boundary; no whole-instance snapshot is required.
Legacy tables can be contracted only in a later migration after production
telemetry and user-visible verification show all consumers use canonical IDs
and labels.
