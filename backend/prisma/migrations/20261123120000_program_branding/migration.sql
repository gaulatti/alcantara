-- gaulatti/alcantara#335: per-program station marks. Additive only: a new table keyed by the
-- Program, with no change to any existing table and no backfill. A program without a row has no
-- branding and draws no marks.
CREATE TABLE "ProgramBranding" (
    "programId" TEXT NOT NULL,
    "displayName" TEXT,
    "callsign" TEXT,
    "subtitle" TEXT,
    "logoUrl" TEXT,
    "hashtag" TEXT,
    "siteUrl" TEXT,
    "defaultChyron" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProgramBranding_pkey" PRIMARY KEY ("programId")
);

ALTER TABLE "ProgramBranding" ADD CONSTRAINT "ProgramBranding_programId_fkey"
    FOREIGN KEY ("programId") REFERENCES "Program"("programId") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: every ProgramState without a Program row gets one, so branding writes never 404 on a
-- program that predates the Program table or was created before createProgram made the row. Rows
-- created here have no team (it cannot be known from the state row); the HTTP create path sets it.
-- Idempotent: a second run inserts nothing.
INSERT INTO "Program" ("programId", "teamId", "channelId", "createdAt", "updatedAt")
SELECT ps."programId", NULL, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "ProgramState" ps
WHERE NOT EXISTS (SELECT 1 FROM "Program" p WHERE p."programId" = ps."programId");
