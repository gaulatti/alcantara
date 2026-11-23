-- CreateTable
CREATE TABLE IF NOT EXISTS "Program" (
    "programId" TEXT NOT NULL,
    "teamId" INTEGER,
    "channelId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Program_pkey" PRIMARY KEY ("programId")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Program_teamId_idx" ON "Program"("teamId");

-- Backfill one row for each distinct programId found in the eight tables that carry one
DO $$
BEGIN
    IF to_regclass('"ProgramState"') IS NOT NULL THEN
        INSERT INTO "Program" ("programId", "teamId", "channelId", "createdAt", "updatedAt")
        SELECT DISTINCT "programId", CAST(NULL AS INTEGER), CAST(NULL AS TEXT), CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        FROM (
            SELECT "programId" FROM "ProgramState" WHERE "programId" IS NOT NULL
            UNION
            SELECT "programId" FROM "BroadcastDestinationSelection" WHERE "programId" IS NOT NULL
            UNION
            SELECT "programId" FROM "BroadcastDestinationCommand" WHERE "programId" IS NOT NULL
            UNION
            SELECT "programId" FROM "BroadcastDestinationRuntime" WHERE "programId" IS NOT NULL
            UNION
            SELECT "programId" FROM "ExternalSourceProgram" WHERE "programId" IS NOT NULL
            UNION
            SELECT "programId" FROM "SimilarityDecision" WHERE "programId" IS NOT NULL
            UNION
            SELECT "programId" FROM "SongIntro" WHERE "programId" IS NOT NULL
            UNION
            SELECT "programId" FROM "GuestInvitation" WHERE "programId" IS NOT NULL
        ) AS distinct_programs
        ON CONFLICT ("programId") DO NOTHING;
    END IF;
END $$;
