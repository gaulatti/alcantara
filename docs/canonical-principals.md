# Canonical Pompeii principals

A Cognito pool subject is not portable. The same operator signing in through a
different pool gets a different subject, so their preferences, their shared
console layouts, and their audit trail all fragment. Pompeii now returns a
canonical `principal_id` that is stable for one real person across pools, and
Alcantara records it beside the subject.

## Inventory

Every field in the schema that carries a pool-local subject:

| Model | Subject column | Canonical column | Kind |
| --- | --- | --- | --- |
| `OperatorPreference` | `subject` | `principalId` | ownership |
| `SharedConsoleLayout` | `ownerSubject` | `ownerPrincipalId` | ownership |
| `GuestInvitation` | `createdByIdentity` | `createdByPrincipalId` | audit |

`SUBJECT_BEARING_FIELDS` in `backend/src/identity/principals.ts` is that list in
code, and a test asserts it matches. A new subject-bearing column that is not
added there would silently escape both the dry run and the migration.

Every canonical column is **nullable and additive**. No subject column is ever
rewritten, and `OperatorPreference`'s primary key stays `[subject, deviceClass]`
so no existing row moves.

## Reads during the migration window

A caller carrying a canonical principal reads migrated rows by principal and
unmigrated rows by subject, so both stay reachable. A caller without one reads
by subject only — it must never fall through to another person's rows.

```
row has principalId  ->  caller's principalId must match
row has none         ->  caller's subject must match
```

`OperatorPreference` lookups try the principal first and fall back to the
subject, so an operator who moves pools still finds their own profile. A write
targets whichever row they already own, and backfills the canonical principal on
it the first time they sign in with one resolved.

## Migrating

`prisma migrate deploy` applies
`20260906180000_canonical_principals`, which adds the three nullable columns and
two indexes and **backfills nothing** — mapping a legacy subject to a canonical
principal requires Pompeii and must never be inferred locally. Every statement is
`IF NOT EXISTS`, so a restart part-way through re-runs safely.

The backfill is a separate, explicit step driven by a verified mapping file — a
JSON array of `{"subject": "...", "principalId": "..."}` pairs from Pompeii:

```bash
cd backend
pnpm principals:report ./mapping.json   # dry run; changes nothing
pnpm principals:apply  ./mapping.json
```

The report classifies every row:

| Classification | Meaning | Applied |
| --- | --- | --- |
| `mapped` | a verified mapping exists and the row can move | ✅ |
| `already-migrated` | already carries that canonical principal | — |
| `missing` | no mapping supplied; the row stays usable on its subject | — |
| `conflicting` | the row already names a **different** principal | ❌ |
| `ambiguous` | the subject maps to more than one principal | ❌ |
| `orphan` | the row carries no subject at all | ❌ |

`apply` runs in one transaction, writes only `mapped` rows, and makes each write
conditional on the canonical column still being null — so it is safe to re-run
and a crash resumes cleanly. It refuses to run while conflicts remain unless
`--allow-conflicts` is passed, and even then migrates only the clean rows.

The report contains counts and opaque row ids only: **no subject, principal, or
email ever appears in it**.

## The two guarantees

- **Identities are never joined by email.** The only accepted input is a mapping
  Pompeii verified. `readMappingFile` refuses an entry that even *contains* an
  `email` field.
- **Audit attribution is never rewritten.** `GuestInvitation.createdByIdentity`
  keeps its original value forever; the canonical principal is recorded beside
  it. A historical actor still displays when no mapping exists, and no link is
  fabricated.

## Rollback and reconciliation

`down.sql` drops only the added columns and indexes. Because the migration never
touched a subject column, reverting cannot lose an ownership or audit value: an
operator's preferences, layouts, and invitation history all remain keyed by the
pool subject exactly as before.

Reconciling after a partial or aborted rollout:

1. Re-run `pnpm principals:report ./mapping.json`. Rows already applied come
   back as `already-migrated`; nothing needs undoing.
2. Resolve any `conflicting` or `ambiguous` rows by hand — those are decisions
   about who a record belongs to, which is why the tool refuses to make them.
3. Re-run `pnpm principals:apply`. It is idempotent.

Unresolved legacy records stay usable and visible throughout; they are never
hidden or orphaned while awaiting remediation.
