-- Additive only: new nullable or defaulted columns and a unique index that
-- existing rows cannot violate (their playbackRequestId is NULL).
ALTER TABLE "AsRunRecord" ADD COLUMN "playbackRequestId" TEXT;
ALTER TABLE "AsRunRecord" ADD COLUMN "inferred" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "AsRunRecord" ADD COLUMN "reviewFlag" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "AsRunRecord_programId_playbackRequestId_state_key" ON "AsRunRecord"("programId", "playbackRequestId", "state");
