# Media library architecture

Alcántara treats images, audio clips, songs, and transition videos as media
assets. A media group is an ordered collection of image assets, not a fifth
asset type. Scenes and scene templates are consumers of media; they are not
media assets.

## Canonical identity

`MediaAsset` is the common registry for every asset. It owns the fields shared
by all asset kinds:

- a stable string ID;
- one bounded kind: `IMAGE`, `AUDIO_CLIP`, `SONG`, or `TRANSITION`;
- a display name;
- the producer-supplied source URL;
- enabled state; and
- creation and update timestamps.

Canonical IDs are deterministic while the legacy tables remain in service:
`image:<id>`, `audio-clip:<id>`, `song:<id>`, and `transition:<id>`. The existing
integer IDs remain authoritative for current program, rundown, radio-settings,
song-intro, scene, and collection references during the migration. Current
media, instant, song, and stinger API responses expose `assetId` as an additive
field; all prior fields and endpoints remain supported.

Type-specific data stays with its existing record during the expand phase.
Examples include an audio clip's volume and position, a song's artist and
artwork, and a transition's cut point. This prevents the common registry from
becoming a nullable catch-all table.

## Migration and consistency contract

The initial migration is additive. It creates and backfills the registry, then
links every existing `Media`, `Instant`, `Song`, and `Stinger` row. It does not
drop, rename, or reinterpret an existing column.

All application create, update, and delete paths write the legacy record and
registry row in one database transaction. The deterministic local seed performs
its registry synchronization in one transaction after its legacy fixtures are
upserted. Application startup then reconciles every legacy row
into the registry and removes orphaned registry rows. The reconciliation covers
the deployment interval in which the migration can finish before the previous
application container stops accepting writes. Startup fails when reconciliation
fails; Alcántara must not serve an incomplete catalog silently.

The bounded `media-asset-reconciliation` background-job metric records success
and failure, and its successful run updates the standard last-success timestamp.
The metric contains no asset IDs, names, or URLs.

## Delivery phases

1. **Expand:** add and backfill `MediaAsset`, keep current endpoints and
   references, and transactionally synchronize every mutation.
2. **Adopt:** introduce one Media Library UI and kind-scoped API views while
   preserving the existing permission for each kind. Rename media groups to
   collections in the interface without changing collection semantics.
3. **Move references:** migrate program, rundown, song-intro, radio-settings,
   scene, and collection references to canonical asset IDs one boundary at a
   time. Reads remain compatible until each writer and consumer has moved.
4. **Contract:** remove legacy duplicate identity and shared fields only after
   production verification shows every writer and consumer uses canonical IDs.

Rollback during the expand phase is code-compatible: the previous application
ignores the additive registry table and nullable link columns. A logical
database backup must still be available before applying the migration so the
entire pre-migration state can be restored if database rollback is required.
