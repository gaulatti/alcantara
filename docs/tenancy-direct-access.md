# Direct tenant-model access (#122)

A tenant model is one the tenancy classification (`backend/src/tenancy/tenancy-classification.ts`) calls `tenant`: it
carries its own `teamId`. The scoped client (`forTeam` in `backend/src/tenancy/scoped-prisma.ts`) confines reads and
writes on those models to one team. Reaching them through the unscoped client, `prisma.<tenantModel>`, reads and writes
every team's rows.

## The two checks

- **Every model is classified.** `tenancy-classification.spec.ts` reads `backend/prisma/schema.prisma`. It fails when
  a model has no class, when the map names a model the schema does not have, or when a class does not match the
  schema. This is the drift check: a new table cannot land without saying who owns its rows.
- **Direct access is a ratchet.** `direct-tenant-access.spec.ts` counts every `prisma.<tenantModel>` member access in
  `backend/src`, outside the tenancy module and outside spec and testing files. A receiver named `prisma` is counted;
  `this.prisma` is one. The counts are kept per file and delegate in `direct-tenant-access.baseline.json`.
  - A new use fails the spec, and so does a higher count in a listed file.
  - A use that is gone fails too, until it is taken off the baseline, so the list only goes down.

  Each new tenant model the classification adds is covered automatically.

## What it does not see

- **A transaction client** (`tx.song` inside `prisma.$transaction`).
- **Raw SQL.**
- **An unscoped client under another name.**

These stay a matter of review, as before.

## Today's list

On `main` at the time of writing, 21 files hold 74 direct uses. They include program lookups that read a program's own
team before scoping. Moving each service onto the scoped client is #122's later slices; each move takes its lines off
the baseline. To regenerate the file after such a move:

```sh
cd backend && npx ts-node -T -e 'import { scanDirectTenantUses } from "./src/tenancy/direct-tenant-access"; import { writeFileSync } from "fs"; writeFileSync("src/tenancy/direct-tenant-access.baseline.json", JSON.stringify(scanDirectTenantUses(process.cwd()), null, 2) + "\n")'
```
