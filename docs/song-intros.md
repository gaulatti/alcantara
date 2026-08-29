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

## Playout

Immediately before every catalog-song command, Alcantara resolves the current
assignment by the sequence item's stable `songId`. Autoplay, shuffle, manual
catalog takes, and Flight song cues therefore use the same lookup path. Items
without a catalog identity remain song-only; Alcantara never guesses an
assignment from URL or display metadata.

An available assignment is sent with the song in one Palazzo
`POST /v1/programs/{programId}/playback/song` request. The song's
`playbackRequestId` is both the request idempotency key and the intro's parent
identity; the deterministic intro ID is `{playbackRequestId}:intro`, so a retry
cannot create a second intro. The Instant's authored volume becomes the intro
gain. Palazzo owns ducking, fades, validation, and the atomic mixer transition.

Alcantara consumes the correlated `intro.started`, `intro.ended`, and
`intro.failed` lifecycle. Intro completion never advances or stops the song.
An unavailable assignment or intro failure leaves the song playing and shows
an **Intro unavailable** state in the radio console. Scheduled bumpers and
manual instants remain independent commands.

## Metrics and ownership boundary

The existing normalized `songs` and `instants` HTTP metrics cover successful
and rejected reads/mutations without placing program, song, or Instant IDs in
labels. No content, media URL, or external identity is added to Prometheus
labels. Atomic playout adds
`alcantara_radio_intro_transitions_total{result}` with the closed results
`submitted`, `accepted`, `started`, `ended`, `failed`, and
`ignored-mismatch`. Palazzo continues to own mixer execution; Alcantara owns
editorial resolution, command correlation, operator state, and lifecycle
metrics.
