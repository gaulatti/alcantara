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

## Program team checks

A request or MCP tool that names a program acts only on a program of the caller's team (gaulatti/alcantara#122): the
path, query or body `programId`, `main` for the routes that name none, and an MCP `program_id`. Another team's program
answers 404 `Program not found` (MCP `not_found`). A program with no team stays usable. Station team `0` (local and
test) is not checked.

A program's team is remembered for 30 seconds and forgotten when the program is created, renamed or deleted. A team
lookup that fails, or takes more than a second, never blocks the request (Stop must work during a database blip); the
last team read for the program still applies. `alcantara_program_team_checks_total{result}` counts `refused`, `unowned`
and `lookup-failed`, all exported at 0.
