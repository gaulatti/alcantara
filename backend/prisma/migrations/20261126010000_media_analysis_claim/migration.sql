-- gaulatti/alcantara#587: which analysis rows a process holds right now, so a new process can hand back the ones a
-- stopped process left, and how often that has happened to the current source. Additive; no row is rewritten.
ALTER TABLE "MediaAssetAnalysis" ADD COLUMN IF NOT EXISTS "claimedAt" TIMESTAMP(3);
ALTER TABLE "MediaAssetAnalysis" ADD COLUMN IF NOT EXISTS "interruptions" INTEGER NOT NULL DEFAULT 0;
