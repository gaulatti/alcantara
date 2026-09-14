CREATE TYPE "MediaAssetKind" AS ENUM ('IMAGE', 'AUDIO_CLIP', 'SONG', 'TRANSITION');

CREATE TABLE "MediaAsset" (
    "id" TEXT NOT NULL,
    "kind" "MediaAssetKind" NOT NULL,
    "name" TEXT NOT NULL,
    "sourceUrl" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MediaAsset_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "Media" ADD COLUMN "assetId" TEXT;
ALTER TABLE "Instant" ADD COLUMN "assetId" TEXT;
ALTER TABLE "Song" ADD COLUMN "assetId" TEXT;
ALTER TABLE "Stinger" ADD COLUMN "assetId" TEXT;

INSERT INTO "MediaAsset" ("id", "kind", "name", "sourceUrl", "enabled", "createdAt", "updatedAt")
SELECT 'image:' || "id", 'IMAGE'::"MediaAssetKind", "name", "imageUrl", true, "createdAt", "updatedAt"
FROM "Media";

INSERT INTO "MediaAsset" ("id", "kind", "name", "sourceUrl", "enabled", "createdAt", "updatedAt")
SELECT 'audio-clip:' || "id", 'AUDIO_CLIP'::"MediaAssetKind", "name", "audioUrl", "enabled", "createdAt", "updatedAt"
FROM "Instant";

INSERT INTO "MediaAsset" ("id", "kind", "name", "sourceUrl", "enabled", "createdAt", "updatedAt")
SELECT
    'song:' || "id",
    'SONG'::"MediaAssetKind",
    CASE WHEN BTRIM("title") <> '' THEN BTRIM("title") ELSE BTRIM("artist") END,
    "audioUrl",
    "enabled",
    "createdAt",
    "updatedAt"
FROM "Song";

INSERT INTO "MediaAsset" ("id", "kind", "name", "sourceUrl", "enabled", "createdAt", "updatedAt")
SELECT 'transition:' || "id", 'TRANSITION'::"MediaAssetKind", "name", "videoUrl", "enabled", "createdAt", "updatedAt"
FROM "Stinger";

UPDATE "Media" SET "assetId" = 'image:' || "id";
UPDATE "Instant" SET "assetId" = 'audio-clip:' || "id";
UPDATE "Song" SET "assetId" = 'song:' || "id";
UPDATE "Stinger" SET "assetId" = 'transition:' || "id";

CREATE UNIQUE INDEX "Media_assetId_key" ON "Media"("assetId");
CREATE UNIQUE INDEX "Instant_assetId_key" ON "Instant"("assetId");
CREATE UNIQUE INDEX "Song_assetId_key" ON "Song"("assetId");
CREATE UNIQUE INDEX "Stinger_assetId_key" ON "Stinger"("assetId");
CREATE INDEX "MediaAsset_kind_updatedAt_idx" ON "MediaAsset"("kind", "updatedAt");

ALTER TABLE "Media"
ADD CONSTRAINT "Media_assetId_fkey"
FOREIGN KEY ("assetId") REFERENCES "MediaAsset"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Instant"
ADD CONSTRAINT "Instant_assetId_fkey"
FOREIGN KEY ("assetId") REFERENCES "MediaAsset"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Song"
ADD CONSTRAINT "Song_assetId_fkey"
FOREIGN KEY ("assetId") REFERENCES "MediaAsset"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Stinger"
ADD CONSTRAINT "Stinger_assetId_fkey"
FOREIGN KEY ("assetId") REFERENCES "MediaAsset"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
