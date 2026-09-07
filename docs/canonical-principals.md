# Canonical Pompeii principals

A Cognito pool subject is not portable. The same operator signing in through a
different pool gets a different subject, so their preferences, their shared
console layouts, and their audit trail all fragment. Pompeii now returns a
canonical `principal_id` that is stable for one real person across pools, and
Alcantara records it beside the subject.

## Inventory

Every field in the schema that carries a pool-local subject:

| Model                 | Subject column             | Canonical column              | Kind      |
| --------------------- | -------------------------- | ----------------------------- | --------- |
| `OperatorPreference`  | `subject`                  | `principalId`                 | ownership |
| `SharedConsoleLayout` | `ownerSubject`             | `ownerPrincipalId`            | ownership |
| `GuestInvitation`     | `createdByIdentity`        | `createdByPrincipalId`        | audit     |
| `GuestEvent`          | `details.operatorIdentity` | `details.operatorPrincipalId` | audit     |

`SUBJECT_BEARING_FIELDS` in `backend/src/identity/principals.ts` is that list in
code, and a test asserts it matches. A new subject-bearing column that is not
added there would silently escape both the dry run and the migration.

Every canonical reference is **nullable and additive**. No subject value is ever
rewritten, and `OperatorPreference`'s primary key stays `[subject, deviceClass]`
so no existing row moves. `GuestEvent` retains the historical subject inside its
JSON details and adds the canonical principal beside it.

`ProgramState` and the related program tables have no operator ownership or
actor-subject field; their `programId` values identify broadcasts, not people.
The in-memory RxJS `Subject` used for event fan-out is likewise not identity
data. They therefore need no identity migration.

## Reads during the migration window

A caller carrying a canonical principal reads migrated rows by principal and
unmigrated rows by subject, so both stay reachable. A caller without one reads
by subject only — it must never fall through to another person's rows.

```
row has principalId  ->  caller's principalId must match
row has none         ->  caller's subject must match
```

`OperatorPreference` lookups query the canonical principal and current subject
together, so an operator who moves pools still finds their own profile without
hiding an unmigrated row for the new pool subject. A write targets the single row
they already own and backfills the canonical principal on it the first time they
sign in with one resolved. Subject fallback is limited to rows whose canonical
principal is still null; a row already owned by another principal cannot be read,
updated, or reset through a matching legacy subject. If those two identities find
distinct owned rows, or two pool-specific rows claim the same principal and
device class, reads fail with `CANONICAL_IDENTITY_COLLISION` until an operator
reconciles them; Alcantara never picks one nondeterministically.

New shared layouts and guest invitations record both identities immediately.
Guest lifecycle audit events retain `operatorIdentity` and add
`operatorPrincipalId`; no historical subject is replaced.

## Migrating

`prisma migrate deploy` applies
`20260906180000_canonical_principals`, which adds the three nullable columns and
two indexes and **backfills nothing** — mapping a legacy subject to a canonical
principal requires Pompeii and must never be inferred locally. Every statement is
`IF NOT EXISTS`, so a restart part-way through re-runs safely.

The backfill is a separate, explicit exchange with Pompeii. Alcantara first
exports the exact consumer/reference/subject inventory; Pompeii resolves that
file and produces its native `{references, collisions, missing}` report, which
Alcantara consumes directly without hand-editing or identity reshaping:

```bash
cd backend
pnpm principals:export ./alcantara-references.json
# Run Pompeii's principal-migration-dry-run using that file and capture its JSON.
pnpm principals:report ./pompeii-report.json   # changes nothing
pnpm principals:apply  ./pompeii-report.json
```

The export is created with mode `0600` and refuses to overwrite an existing file.
It contains identity references: keep it out of Git and logs, transfer it only
through an approved protected channel, and delete it after the migration window.
Every entry must use consumer `alcantara` and the deterministic model/reference
key Alcantara exported. Report/apply reject another consumer, an unknown or
changed reference, or a report that does not cover the current inventory.

The report classifies every row:

| Classification     | Meaning                                                       | Applied |
| ------------------ | ------------------------------------------------------------- | ------- |
| `mapped`           | a verified mapping exists and the row can move                | ✅      |
| `already-migrated` | already carries that canonical principal                      | —       |
| `missing`          | no mapping supplied; the row stays usable on its subject      | —       |
| `conflicting`      | the row already names a **different** principal               | ❌      |
| `ambiguous`        | the subject maps to more than one principal                   | ❌      |
| `colliding`        | multiple preference rows would claim one principal/device key | ❌      |
| `orphan`           | the row carries no subject at all                             | ❌      |

Before any export, report, or apply database access, the CLI runs the canonical
Arauco secret bootstrap; production therefore resolves `DATABASE_URL` from
`ARAUCO_SECRET_ID` before constructing Prisma. Bootstrap failure performs no
database work.

`apply` re-collects and re-plans inside one serializable transaction, writes only
`mapped` rows, and compare-and-sets every legacy owner and canonical-null field.
GuestEvent compares the complete original JSON before adding the principal, so a
concurrent audit update cannot be overwritten. Every affected count must equal
one or the whole transaction aborts. It is safe to re-run and a crash resumes
cleanly. Any collision or missing reference in the Pompeii report always blocks
apply. Alcantara conflicts also block unless `--allow-conflicts` is passed, and
even then only clean rows migrate.

The report contains counts only: **no subject, principal, email, or raw mapping
value ever appears in it**.

## The two guarantees

- **Identities are never joined by email.** The only accepted input is Pompeii's
  native verified report. The importer refuses a reference that even _contains_
  an `email` field.
- **Audit attribution is never rewritten.** `GuestInvitation.createdByIdentity`
  keeps its original value forever; the canonical principal is recorded beside
  it. A historical actor still displays when no mapping exists, and no link is
  fabricated.

Canonical resolution adds no identity-bearing metric labels. Preference reads
continue using the bounded
`alcantara_operator_preference_operations_total{action,result}` family; a
runtime canonical collision records the existing `read`/`conflict` result.

## Rollback and reconciliation

`down.sql` drops only the added columns and indexes. Because the migration never
touches a subject value, reverting cannot lose an ownership or audit value: an
operator's preferences, layouts, invitation history, and event history all
retain the pool subject exactly as before. Nested `operatorPrincipalId` audit
values may remain after a schema rollback; they are additive historical context
and are ignored by legacy code.

Reconciling after a partial or aborted rollout:

1. Re-export the current inventory, regenerate the Pompeii report, and run
   `pnpm principals:report ./pompeii-report.json`. Rows already applied come
   back as `already-migrated`; nothing needs undoing.
2. Resolve any `conflicting`, `ambiguous`, or `colliding` rows by hand — those
   are decisions about who a record belongs to, which is why the tool refuses to
   make them.
3. Re-run `pnpm principals:apply ./pompeii-report.json`. It is idempotent.

Unresolved legacy records stay usable and visible throughout; they are never
hidden or orphaned while awaiting remediation.
