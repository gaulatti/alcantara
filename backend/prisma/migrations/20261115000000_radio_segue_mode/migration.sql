-- Additive migration for RadioSettings segueMode and MediaAssetAnalysis
ALTER TABLE "RadioSettings" ADD COLUMN "segueMode" TEXT NOT NULL DEFAULT 'off';

CREATE TABLE IF NOT EXISTS "MediaAssetAnalysis" (
  "assetId" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "cueInSeconds" DOUBLE PRECISION,
  "cueOutSeconds" DOUBLE PRECISION,
  "fadeInSeconds" DOUBLE PRECISION,
  "fadeOutSeconds" DOUBLE PRECISION,
  "overlapSeconds" DOUBLE PRECISION,
  "integratedLufs" DOUBLE PRECISION,
  "truePeakDbtp" DOUBLE PRECISION,
  "isrc" TEXT,
  "musicbrainzRecordingId" TEXT,
  "error" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MediaAssetAnalysis_pkey" PRIMARY KEY ("assetId"),
  CONSTRAINT "MediaAssetAnalysis_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "MediaAsset"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
