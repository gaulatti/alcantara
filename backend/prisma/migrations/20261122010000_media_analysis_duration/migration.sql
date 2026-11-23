-- Additive only: one nullable column. Existing rows read NULL until the analysis job
-- measures them again at its own pace, one asset at a time (gaulatti/alcantara#296); no
-- row is updated here.
ALTER TABLE "MediaAssetAnalysis" ADD COLUMN "durationSeconds" DOUBLE PRECISION;
