-- gaulatti/alcantara#478: programs created before #335 got their Program row from the
-- 20261123120000_program_branding backfill with teamId NULL, so team-scoped lookups keyed by the
-- program's team miss for them (#464). New programs take the creating caller's team (#335); for
-- the old ones the creator is not recorded, so the team is read from the library rows the program
-- is built from. Scenes, media groups, stingers and external sources are tenant-scoped, so an
-- operator can attach only their own team's rows.
--
-- A NULL-team program whose attached rows name exactly one positive team gets that team. No team,
-- or more than one, leaves it NULL and raises a notice naming it. A program that has a team is
-- never touched. Idempotent: a second run inserts and updates nothing. One small UPDATE per
-- program; the shared database has only a few.

-- Any ProgramState still without a Program row gets one (the #335 backfill, repeated; a no-op
-- when every program already has a row).
INSERT INTO "Program" ("programId", "teamId", "channelId", "createdAt", "updatedAt")
SELECT ps."programId", NULL, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "ProgramState" ps
WHERE NOT EXISTS (SELECT 1 FROM "Program" p WHERE p."programId" = ps."programId");

DO $$
DECLARE
  program_row RECORD;
  candidate_teams INTEGER[];
BEGIN
  FOR program_row IN
    SELECT p."programId" FROM "Program" p WHERE p."teamId" IS NULL ORDER BY p."programId"
  LOOP
    SELECT array_agg(DISTINCT candidate."teamId" ORDER BY candidate."teamId")
    INTO candidate_teams
    FROM (
      SELECT s."teamId"
      FROM "ProgramState" ps
      JOIN "ProgramScene" link ON link."programStateId" = ps."id"
      JOIN "Scene" s ON s."id" = link."sceneId"
      WHERE ps."programId" = program_row."programId"
      UNION
      SELECT g."teamId"
      FROM "ProgramState" ps
      JOIN "ProgramMediaGroup" link ON link."programStateId" = ps."id"
      JOIN "MediaGroup" g ON g."id" = link."mediaGroupId"
      WHERE ps."programId" = program_row."programId"
      UNION
      SELECT st."teamId"
      FROM "ProgramState" ps
      JOIN "ProgramStinger" link ON link."programStateId" = ps."id"
      JOIN "Stinger" st ON st."id" = link."stingerId"
      WHERE ps."programId" = program_row."programId"
      UNION
      SELECT source."teamId"
      FROM "ExternalSourceProgram" link
      JOIN "ExternalSource" source ON source."id" = link."sourceId"
      WHERE link."programId" = program_row."programId"
    ) candidate
    WHERE candidate."teamId" IS NOT NULL AND candidate."teamId" > 0;

    IF cardinality(candidate_teams) = 1 THEN
      UPDATE "Program"
      SET "teamId" = candidate_teams[1], "updatedAt" = CURRENT_TIMESTAMP
      WHERE "programId" = program_row."programId" AND "teamId" IS NULL;
    ELSE
      RAISE NOTICE 'program_team_backfill: % keeps no team (% candidate teams)',
        program_row."programId", COALESCE(cardinality(candidate_teams), 0);
    END IF;
  END LOOP;
END $$;
