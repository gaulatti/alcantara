-- gaulatti/carmencita#4: an audit row for every request of a destination's ingest credential.
-- Additive only: a new table, no change to any existing table. The credential is never stored.
CREATE TABLE "BroadcastIngestAccess" (
    "id" TEXT NOT NULL,
    "teamId" INTEGER,
    "destinationId" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BroadcastIngestAccess_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "BroadcastIngestAccess_teamId_idx" ON "BroadcastIngestAccess"("teamId");
CREATE INDEX "BroadcastIngestAccess_destinationId_createdAt_idx" ON "BroadcastIngestAccess"("destinationId", "createdAt");
CREATE INDEX "BroadcastIngestAccess_subject_createdAt_idx" ON "BroadcastIngestAccess"("subject", "createdAt");
