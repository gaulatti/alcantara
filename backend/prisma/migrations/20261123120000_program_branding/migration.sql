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
