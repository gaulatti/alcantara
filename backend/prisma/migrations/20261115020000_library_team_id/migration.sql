-- AlterTable
ALTER TABLE "BroadcastDestination" ADD COLUMN IF NOT EXISTS "teamId" INTEGER;

-- AlterTable
ALTER TABLE "BroadcastSettings" ADD COLUMN IF NOT EXISTS "teamId" INTEGER;

-- AlterTable
ALTER TABLE "Instant" ADD COLUMN IF NOT EXISTS "teamId" INTEGER;

-- AlterTable
ALTER TABLE "Layout" ADD COLUMN IF NOT EXISTS "teamId" INTEGER;

-- AlterTable
ALTER TABLE "Media" ADD COLUMN IF NOT EXISTS "teamId" INTEGER;

-- AlterTable
ALTER TABLE "MediaAsset" ADD COLUMN IF NOT EXISTS "teamId" INTEGER;

-- AlterTable
ALTER TABLE "MediaGroup" ADD COLUMN IF NOT EXISTS "teamId" INTEGER;

-- AlterTable
ALTER TABLE "MediaLabel" ADD COLUMN IF NOT EXISTS "teamId" INTEGER;

-- AlterTable
ALTER TABLE "Scene" ADD COLUMN IF NOT EXISTS "teamId" INTEGER;

-- AlterTable
ALTER TABLE "Song" ADD COLUMN IF NOT EXISTS "teamId" INTEGER;

-- AlterTable
ALTER TABLE "Stinger" ADD COLUMN IF NOT EXISTS "teamId" INTEGER;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "BroadcastDestination_teamId_idx" ON "BroadcastDestination"("teamId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "BroadcastSettings_teamId_idx" ON "BroadcastSettings"("teamId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Instant_teamId_idx" ON "Instant"("teamId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Layout_teamId_idx" ON "Layout"("teamId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Media_teamId_idx" ON "Media"("teamId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "MediaAsset_teamId_idx" ON "MediaAsset"("teamId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "MediaGroup_teamId_idx" ON "MediaGroup"("teamId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "MediaLabel_teamId_idx" ON "MediaLabel"("teamId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Scene_teamId_idx" ON "Scene"("teamId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Song_teamId_idx" ON "Song"("teamId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Stinger_teamId_idx" ON "Stinger"("teamId");
