# Program team ownership

Every program has one `Program` row (`backend/prisma/schema.prisma`), and its `teamId` is the Pompeii team that owns the program. Team-scoped reads and writes that are keyed by the program's team use it. Team 0 is the test-mode value: it is stored as NULL, never as a team.

## How a program gets its team

- **New programs (#335):** `createProgram` creates the `Program` row in the same transaction as the `ProgramState`, with the creating caller's team.
- **Programs that predate #335:** the `20261123120000_program_branding` backfill gave them a row with `teamId` NULL. The creator isn't recorded anywhere, and `OperatorChangeRecord.teamId` is always NULL.
- **Backfill (#478):** `20261124000000_program_team_backfill` reads the team from the library rows the program is built from: its scenes (`ProgramScene`), media groups (`ProgramMediaGroup`), stingers (`ProgramStinger`) and external sources (`ExternalSourceProgram`). All four are tenant-scoped, so an operator can attach only their own team's rows.
  - **Exactly one positive team** on those rows: the program gets that team.
  - **No positive team, or more than one:** `teamId` stays NULL, and the migration raises a notice: `program_team_backfill: <programId> keeps no team (<n> candidate teams)`.
  - **A program that already has a team** is never changed.
  - **Re-running** the migration inserts and updates nothing.

## Renaming a program

The `Program` row is renamed with the program, so its team and branding stay with it. A deleted program leaves its
row behind; renaming onto that id is refused with 409 (`That ID belongs to a deleted show's settings. Choose another
ID.`), and nothing is removed.

## Programs still without a team

After the deploy, this read-only query lists the programs the backfill couldn't assign, with how many distinct positive teams their attachments name:

```sql
SELECT p."programId",
       (SELECT count(DISTINCT t) FROM (
          SELECT s."teamId" t FROM "ProgramState" ps JOIN "ProgramScene" l ON l."programStateId" = ps."id"
            JOIN "Scene" s ON s."id" = l."sceneId" WHERE ps."programId" = p."programId"
          UNION SELECT g."teamId" FROM "ProgramState" ps JOIN "ProgramMediaGroup" l ON l."programStateId" = ps."id"
            JOIN "MediaGroup" g ON g."id" = l."mediaGroupId" WHERE ps."programId" = p."programId"
          UNION SELECT st."teamId" FROM "ProgramState" ps JOIN "ProgramStinger" l ON l."programStateId" = ps."id"
            JOIN "Stinger" st ON st."id" = l."stingerId" WHERE ps."programId" = p."programId"
          UNION SELECT e."teamId" FROM "ExternalSourceProgram" l JOIN "ExternalSource" e ON e."id" = l."sourceId"
            WHERE l."programId" = p."programId"
        ) c WHERE t > 0) AS candidate_teams
FROM "Program" p
WHERE p."teamId" IS NULL
ORDER BY p."programId";
```

The owner assigns the team of each listed program by hand. Until then, readers that need a team for such a program use their own fallback, for example the recipes' caller team (#464).

## Renaming a program that is on air

A rename is refused with 409 while the program is on air (a scene or fade to black, a running log, a playing song or
scene instant): `This show is on air (…). Take it off air before renaming it.` After a rename the radio engine and
Palazzo telemetry take up the new id in one step. Palazzo itself must be configured for the new program id.
