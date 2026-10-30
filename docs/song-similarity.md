# Song similarity (spike)

Chooses the next radio song by audio similarity instead of cursor order. Each
song has two embeddings, one for its **opening** and one for its **closing**.
When a song ends, `cosine(current.closing, candidate.opening)` ranks the
candidates and the best one that passes the threshold and the rotation rules
plays next. Built and first enabled for `modoitaliano`; every station defaults
to `off`, in which case selection is byte-for-byte the previous behavior.

## Model and license

| | |
|---|---|
| Model | Discogs-EffNet, `discogs-effnet-bs64-1` (Essentia), 1,280-dimension embeddings |
| License | CC BY-NC-SA 4.0 (non-commercial). Acceptable for Modo Italiano because it does not monetize; revisit before using it on any monetized station. |
| Preprocessing | Essentia's own: `MonoLoader` at 16 kHz mono, then `TensorflowPredictEffnetDiscogs` with output `PartitionedCall:1` (the model's built-in mel front end). Nothing is reimplemented in TypeScript. |

Every stored vector records `model`, `modelVersion`, `license`,
`windowSeconds` and `audioSha256`, so vectors can be recomputed later with a
different model. The backend only accepts the model named in
`song-similarity.utils.ts` (`SIMILARITY_MODEL`).

## Storage

Table `SongEmbedding(songId, segment opening|closing, model, modelVersion,
license, windowSeconds, audioSha256, vector, computedAt)`, unique on
`(songId, segment, model, windowSeconds)`, cascading on song delete. `vector`
is pgvector's dimensionless `vector` type, read and written with raw SQL
(Prisma cannot model it). The migration runs `CREATE EXTENSION IF NOT EXISTS
vector`, so the database role needs permission to create it, or an admin must
create it first. Because selection is synchronous, the backend loads the
vectors into memory and ranks them there (brute force; the catalog is small).
The cache refreshes on settings change, on upload and every five minutes while
any station is not `off`. A disabled or deleted song can therefore stay
pickable for up to five minutes.

Other tables/columns, all additive: `RadioSettings.similarityMode`
(`off|shadow|on`, default `off`), `similarityThreshold` (default 0.8),
`similarityWindowSeconds` (default 30), `similarityPool` (`sequence|catalog`);
`ProgramState.songArtistCycle`; `SimilarityDecision` (capped at about 1,000
rows per program). Rollback: drop the two new tables and the added columns; the
extension may stay installed.

Local Compose and CI now use `pgvector/pgvector:pg17` instead of
`postgres:17-alpine`. Existing local volumes were created by the Alpine image
(different libc collations): run `docker compose down -v` to recreate and
reseed the local database.

## Modes

- **off** (default): nothing is read or written; the engine behaves as before.
- **shadow**: on-air selection is unchanged. At every automatic song change the
  engine also computes what the picker would choose and records it
  (`SimilarityDecision`: current song, proposed song, score, up to three
  runner-ups, and the song the unchanged logic selected). "Played" is the song
  selected at that moment, before Palazzo confirms it.
- **on**: the highest-scoring candidate plays next.

Eligibility in `on` (and for shadow proposals):

1. The current (just ended) song has a closing embedding and the candidate has
   an opening embedding, same model and window.
2. Score >= `similarityThreshold`.
3. High-rotation favorites are never ranked: the existing quota scheduler
   still decides when they air, and runs first.
4. The just-ended song is excluded.
5. **Artist cycle**: only artists that have not played in the current cycle are
   eligible. When no eligible candidate remains (every artist has played), a
   new cycle starts containing only the artist that just played, so an artist
   never repeats back to back. A cycle counts only artists with at least one
   embedded candidate. Songs aired by any path (fallback, queue, timed block)
   mark their artist as played while mode is not `off`.

**Candidate pool**: `sequence` ranks only the songs in the station's saved
playlist. `catalog` ranks the playlist first and, only when no playlist song
qualifies, ranks the other enabled catalog songs that have embeddings. A song
played from outside the playlist does not move the cursor, so the cursor's next
song is not skipped. After a backend restart mid-song, a catalog pick is not
recognised as part of the playlist and is treated like any unrecognised
playback (it is not advanced from).

**Fallback**: if the current song has no embedding (`fallback-no-embedding`),
or no candidate qualifies (`fallback-no-candidate`), or the picker throws, the
existing cursor behavior runs and the reason is recorded. Queued songs, manual
songs, timed blocks and Palazzo reconciliation keep their existing precedence;
the picker only runs where the engine previously chose the next playlist song.

## Metrics

`alcantara_radio_similarity_total{result}` on the authenticated `/metrics`
endpoint, with the bounded results `selected`, `fallback-no-candidate`,
`fallback-no-embedding`, `shadow-recorded` and
`decision-persistence-failed`. In shadow mode only `shadow-recorded` is
counted (the outcome is in the decision row). No song, artist or URL appears in
labels.

## Operating it

All of this is on the Radio distribution page, in **Song similarity**
(`GET/PUT /radio/:programId/settings` carries the four settings; `PUT` needs
`radio.manage`).

1. **Export**: choose the scope (playlist or whole catalog) and, usually,
   "only songs without embeddings", then download `songs-to-analyze.json`
   (`GET /radio/:programId/similarity/export`, `radio.manage`).
2. **Analyze on your own computer** (not the production backend):
   see `spikes/song-similarity/README.md`. It writes `embeddings.json` and
   needs no credentials or database access. It is resumable.
3. **Upload** `embeddings.json` in the same panel
   (`POST /radio/:programId/similarity/embeddings`, `radio.manage`, at most 25
   songs per request; the UI sends 10). Every vector is validated (1,280
   dimensions, finite, unit norm), the song must exist, and results are
   reported per song.
4. Set the mode to **Shadow**, let it run, and review
   `GET /radio/:programId/similarity/decisions` (`radio.read`) or the table in
   the panel. When the proposals look right, switch to **On**.

Enabling shadow mode for `modoitaliano`: Radio distribution > Song similarity >
Mode = Shadow > Save (or `PUT /radio/modoitaliano/settings` with
`{"similarityMode":"shadow"}`).

## Recalculating with another model

Add the model to `SIMILARITY_MODEL`/the validator and `analyze.py`, export with
"whole catalog", analyze, upload. Rows are keyed by `(song, segment, model,
window)`, so the old model's vectors stay until deleted. Changing the window in
the panel only helps once songs have been analyzed at that window; until then
the coverage line shows them as missing and the picker falls back.

## Evaluation pairs

`backend/src/radio/song-similarity.fixtures.ts` has a clearly marked empty place
for song-ID pairs that must rank high and pairs that must never pass the
threshold. They are not yet checked by an automated test, because that needs
real embeddings; fill the lists and run the comparison against an export.
