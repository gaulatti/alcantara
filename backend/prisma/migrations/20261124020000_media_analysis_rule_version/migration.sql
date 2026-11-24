-- gaulatti/alcantara#235: which cue rule placed a song's cue points, so a re-analysis in batches can be audited and
-- reverted. Additive: one nullable column; rows analysed before it stay null (rule 1).
ALTER TABLE "MediaAssetAnalysis" ADD COLUMN "ruleVersion" INTEGER;
