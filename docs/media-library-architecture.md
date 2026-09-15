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
