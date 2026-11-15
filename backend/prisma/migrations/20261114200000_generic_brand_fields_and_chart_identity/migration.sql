-- Additive. Introduces generic brand fields per program and generic chart identity table.
-- Rollback: DROP TABLE "SongChartIdentity"; ALTER TABLE "ProgramState" DROP COLUMN "genericBrandFields";

ALTER TABLE "ProgramState" ADD COLUMN "genericBrandFields" BOOLEAN DEFAULT false;

CREATE TABLE "SongChartIdentity" (
  "id" SERIAL NOT NULL,
  "songId" INTEGER NOT NULL,
  "provider" TEXT NOT NULL,
  "externalId" TEXT,
  "rank" TEXT,
  "spins" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SongChartIdentity_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SongChartIdentity_songId_fkey" FOREIGN KEY ("songId") REFERENCES "Song"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "SongChartIdentity_songId_key" ON "SongChartIdentity"("songId");
