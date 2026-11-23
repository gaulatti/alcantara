-- gaulatti/alcantara#126: per-program television and radio filler
-- configuration. Additive only: two new tables and no change to an existing
-- table, so a program with no filler configured behaves exactly as before.
-- Rollback is forward only: a later migration drops "FillerLeg" and
-- "FillerVersion", alongside a code change that removes the filler routes.

CREATE TABLE "FillerVersion" (
    "id" TEXT NOT NULL,
    "programId" TEXT NOT NULL,
    "leg" TEXT NOT NULL,
    "checksum" TEXT NOT NULL,
    "config" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'preparing',
    "reason" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "preparedAt" TIMESTAMP(3),
    CONSTRAINT "FillerVersion_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "FillerVersion_programId_leg_createdAt_idx" ON "FillerVersion"("programId", "leg", "createdAt");

CREATE TABLE "FillerLeg" (
    "programId" TEXT NOT NULL,
    "leg" TEXT NOT NULL,
    "pendingVersionId" TEXT,
    "activeVersionId" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "FillerLeg_pkey" PRIMARY KEY ("programId", "leg")
);
