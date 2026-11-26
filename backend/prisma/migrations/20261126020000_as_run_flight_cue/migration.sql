-- gaulatti/alcantara#726: the rundown cue a not-aired row was written for, so the rundown can show that cue as skipped
-- instead of played. Additive; older rows keep null and no row is rewritten.
ALTER TABLE "AsRunRecord" ADD COLUMN "flightSequenceId" INTEGER;
ALTER TABLE "AsRunRecord" ADD COLUMN "flightCueId" TEXT;
CREATE INDEX "AsRunRecord_flightSequenceId_idx" ON "AsRunRecord"("flightSequenceId");
