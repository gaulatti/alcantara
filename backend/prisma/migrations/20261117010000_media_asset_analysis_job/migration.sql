-- Additive: retry bookkeeping and the analysed source for the media analysis job.
-- AlterTable
ALTER TABLE "MediaAssetAnalysis" ADD COLUMN     "attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "nextAttemptAt" TIMESTAMP(3),
ADD COLUMN     "sourceUrl" TEXT;
