# Song intro editorial model

Alcantara owns the editorial relationship between a catalog song and its
recorded voice intro. Palazzo receives that relationship only when a later
playout command is prepared; it must not infer an intro from artist, title, or
other display metadata.

## Terminology

- A **song intro** is one existing Instant assigned to one catalog song. Its
  recording is intended to overlap the opening of that song.
- A **station bumper/ID** is selected in Radio settings and is scheduled
  sequentially between songs.
- A **manual instant** is an independent operator-triggered overlay.

These paths remain separate. Assigning an Instant as a song intro does not add
it to bumper rotation and does not change manual Instant behavior.

## Persistence and API

`SongIntro` stores one `songId`, one `instantId`, and the owning `programId`.
Both asset identities are unique, so a song has at most one active intro and an
Instant cannot be assigned to multiple songs. The API hydrates the referenced
Instant rather than copying its URL or authored gain.

Song create/update accepts `programId` plus `introInstantId`. A numeric value
assigns or replaces the intro; `null` removes it; omission leaves it unchanged.
Song reads accept `programId` and expose only that program's assignment.
Assignments fail closed when the program or Instant is missing, the Instant is
disabled or lacks audio, the Instant is already assigned, or an existing song
relationship belongs to another program. Deleting an assigned Instant is
rejected until the relationship is removed.

Sequence leaf items created from the catalog persist a numeric `songId` in
addition to display and media metadata. Existing metadata-only sequence items
remain valid and explicitly have no catalog identity; consumers must not guess
one from title, artist, artwork, or URL.

## Editor workflow

In Songs, edit a catalog item and use **Song intro** to assign, preview, replace,
or remove an eligible Instant. The editor identifies unavailable recordings and
explains the separate bumper and manual-Instant concepts. Saving persists the
song and relationship together, so a validation failure leaves both unchanged.

The deterministic local seed provides a song with an assigned intro, a song
without an intro, the already-assigned (therefore unavailable) Instant, and an
available voice recording. Run the documented Compose migration and seed path
to restore those fixtures.

## Metrics and ownership boundary

The existing normalized `songs` and `instants` HTTP metrics cover successful
and rejected reads/mutations without placing program, song, or Instant IDs in
labels. No content, media URL, or external identity is added to Prometheus
labels. This ticket models and edits the relationship only; Palazzo command and
mixer behavior are owned by the dependent atomic playout work.
