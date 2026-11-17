# Program filler configuration

This document covers gaulatti/alcantara#126. Each program leg can hold an immutable filler configuration: the media its executor plays when there is nothing live. Television fillers are prepared by Alana and Croccante; radio fillers by Palazzo.

The executor contract is pinned in the gaulatti/alcantara#126 ticket. It is built reader-first against gaulatti/alana#29: Alana's effective live profile, and a `profileChecksum` on its filler acknowledgement.

**A program with no filler configured has no filler, and behaves exactly as before.** There is no per-program off switch.

## Model

`FillerVersion` is one immutable configuration for one program leg.
- **Identity:** an id `filler-tv-<uuid>` or `filler-radio-<uuid>`, plus `programId` and `leg`.
- **Configuration:** the stored config holds the source asset ids with their SHA-256 and the mode (`loop` for television, `ordered` or `shuffle` with a `shuffleSeed` for radio). A television version also records the live-profile checksum it was prepared against.
- **Checksum:** `checksum` is the SHA-256 of the canonical JSON of program, leg and configuration.
- **Status:** a version starts as `preparing` and moves once, to `ready` or to `failed` with a bounded `reason` (`executor-rejected` or `acknowledgement-mismatch`).
- **Never stored:** download URLs and credentials.

`FillerLeg` holds, per program and leg:
- `pendingVersionId`: the prepared next-session version;
- `activeVersionId`: the version bound to the running session.

Only a `ready` version becomes pending, so a failed preparation leaves the known-good versions in place. A slower, older preparation never replaces a newer pending version. The television and radio legs of a `both` program are independent.

## API

All routes sit under `/broadcast/programs/:programId/fillers`.

| Method and path | Permission | Effect |
| --- | --- | --- |
| `GET /` | `broadcast.view` | The pending and active version of each leg the program has (`tv` gives television, `radio` gives radio, `both` gives both). |
| `PUT /television` with `{ assetId }` | `broadcast.manage` | Prepares an enabled `IMAGE` or `VIDEO` media asset (including WebM). |
| `PUT /radio` with `{ assetIds, mode?, shuffleSeed? }` | `broadcast.manage` | Prepares 1 to 100 distinct enabled `AUDIO` media assets, `ordered` by default or `shuffle` with a bounded seed. |

**Source checks.** Sources must be on the managed `MEDIA_S3_BUCKET`, over https, with no credentials or port, between 1 byte and 512 MiB. Alcantara reads each one once to compute its SHA-256.

**Television preparation:**
1. Alcantara reads Alana's `GET /v1/programs/:id/live-profile`.
2. If that returns 404 (an Alana without gaulatti/alana#29), preparation is refused with 503 "television live profile unavailable". Alcantara never guesses a profile.
3. Otherwise it sends the exact profile in Alana's `PUT /fillers/:version`.
4. The version is ready only when the acknowledgement matches on all of: version, `ready: true`, `status: "ready"`, source id, source SHA-256, and `profileChecksum` equal to the live-profile checksum.

**Radio preparation** uses Palazzo's `PUT /fillers/:version` with the mode and seed, through the existing private Palazzo URL allowlist.

## Start binding

**Television.** `POST /broadcast/programs/:id/start` (`broadcast.operate`) applies binding only when two things hold: the program has a ready television version (pending, else active), and Alana's lifecycle reports `pendingFiller` or `activeFiller` with a `profileChecksum`.
- Start is sent only if Alana holds that exact version, ready, with the same profile checksum. Otherwise the request fails with 409 before anything is sent.
- After Running, Alana's `activeFiller` must be that version. Then it becomes the leg's active version and stops being pending.
- A mismatch after Start is reported as 502 and leaves the leg unchanged.
- With no filler, or an Alana without profile checksums, Start is exactly as before.

**Radio.** Recovery Start (`POST /radio/:id/recovery/start`) binds to the program radio version when one is configured, and marks it active on success. Otherwise it uses the legacy prepared recovery version exactly as before.

**Legacy recovery writer.** The `radio.manage` route `POST /radio/:id/recovery/prepare` is a second writer of the radio filler. Once a program radio filler exists, that route answers 409 ("the radio filler is managed by the program filler configuration"), so only `broadcast.manage` can change the policy. For every program without one it is unchanged.

## Metrics

| Metric | Labels |
| --- | --- |
| `alcantara_filler_preparations_total{leg,result}` | `leg` is `television` or `radio`; `result` is `ready`, `failed`, `unavailable` or `profile-unavailable` |
| `alcantara_filler_start_bindings_total{result}` | `bound`, `mismatch`, `not-configured` or `legacy-executor` |
| `alcantara_dependency_operations_total{dependency="alana",...}` | gains the `profile` and `prepare` operations |

Every series is exposed at zero from the first scrape. Palazzo's `filler-prepare` machine metrics count an answer with an unknown `status` (still `ready: true` with the exact version echo) as `result="unknown-value"` instead of failing the preparation (see [radio-telemetry.md](radio-telemetry.md)). No program, version, asset or URL appears in a label.

## Migration and rollback

The migration `20261121000000_program_filler` is additive: it creates the `FillerVersion` and `FillerLeg` tables and changes no existing table. Both tables carry a `programId` and are classified `program` for tenancy.

**Rollback is forward only:**
1. A code change removes the filler routes and their callers.
2. A later migration runs `DROP TABLE "FillerLeg"; DROP TABLE "FillerVersion";`.

The drop is safe after rows exist: nothing else references these tables, and existing programs never read them. Dropping them only discards configured filler versions, after which every program behaves as before.

**What puts it live:** merging `backend/**` to main runs Backend Deploy, which applies `db:migrate:deploy` before the new backend starts.
