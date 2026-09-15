CREATE TYPE "MediaAssetType" AS ENUM ('IMAGE', 'AUDIO', 'VIDEO');

ALTER TABLE "MediaAsset" ADD COLUMN "mediaType" "MediaAssetType";

UPDATE "MediaAsset"
SET "mediaType" = CASE
    WHEN "kind" = 'IMAGE'::"MediaAssetKind" THEN 'IMAGE'::"MediaAssetType"
    WHEN "kind" IN ('AUDIO_CLIP'::"MediaAssetKind", 'SONG'::"MediaAssetKind") THEN 'AUDIO'::"MediaAssetType"
    WHEN "kind" = 'TRANSITION'::"MediaAssetKind" THEN 'VIDEO'::"MediaAssetType"
END;

ALTER TABLE "MediaAsset" ALTER COLUMN "kind" DROP NOT NULL;

ALTER TABLE "Song" ADD COLUMN "coverAssetId" TEXT;

INSERT INTO "MediaAsset" (
    "id", "kind", "mediaType", "name", "sourceUrl", "enabled", "createdAt", "updatedAt"
)
SELECT
    'song-cover:' || "id",
    NULL,
    'IMAGE'::"MediaAssetType",
    CASE
        WHEN BTRIM("artist") <> '' AND BTRIM("title") <> '' THEN "artist" || ' - ' || "title" || ' cover'
        WHEN BTRIM("title") <> '' THEN "title" || ' cover'
        ELSE "artist" || ' cover'
    END,
    "coverUrl",
    "enabled",
    "createdAt",
    "updatedAt"
FROM "Song"
WHERE "coverUrl" IS NOT NULL AND BTRIM("coverUrl") <> '';

UPDATE "Song"
SET "coverAssetId" = 'song-cover:' || "id"
WHERE "coverUrl" IS NOT NULL AND BTRIM("coverUrl") <> '';

CREATE TABLE "BackgroundAudioCapability" (
    "assetId" TEXT NOT NULL,
    "defaultVolume" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BackgroundAudioCapability_pkey" PRIMARY KEY ("assetId")
);

CREATE TABLE "MediaLabel" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MediaLabel_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "MediaAssetLabel" (
    "labelId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MediaAssetLabel_pkey" PRIMARY KEY ("labelId", "assetId")
);

INSERT INTO "MediaLabel" ("id", "name", "description", "createdAt", "updatedAt")
SELECT 'legacy-media-group:' || "id", "name", "description", "createdAt", "updatedAt"
FROM "MediaGroup";

INSERT INTO "MediaAssetLabel" ("labelId", "assetId", "position", "createdAt")
SELECT
    'legacy-media-group:' || item."mediaGroupId",
    media."assetId",
    item."position",
    label."createdAt"
FROM "MediaGroupItem" AS item
JOIN "Media" AS media ON media."id" = item."mediaId"
JOIN "MediaLabel" AS label ON label."id" = 'legacy-media-group:' || item."mediaGroupId"
WHERE media."assetId" IS NOT NULL;

CREATE UNIQUE INDEX "MediaLabel_name_key" ON "MediaLabel"("name");
CREATE UNIQUE INDEX "MediaAssetLabel_labelId_position_key" ON "MediaAssetLabel"("labelId", "position");
CREATE INDEX "MediaAssetLabel_assetId_idx" ON "MediaAssetLabel"("assetId");
CREATE INDEX "MediaAsset_mediaType_updatedAt_idx" ON "MediaAsset"("mediaType", "updatedAt");
CREATE INDEX "Song_coverAssetId_idx" ON "Song"("coverAssetId");

ALTER TABLE "BackgroundAudioCapability"
ADD CONSTRAINT "BackgroundAudioCapability_assetId_fkey"
FOREIGN KEY ("assetId") REFERENCES "MediaAsset"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "MediaAssetLabel"
ADD CONSTRAINT "MediaAssetLabel_labelId_fkey"
FOREIGN KEY ("labelId") REFERENCES "MediaLabel"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Song"
ADD CONSTRAINT "Song_coverAssetId_fkey"
FOREIGN KEY ("coverAssetId") REFERENCES "MediaAsset"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "MediaAssetLabel"
ADD CONSTRAINT "MediaAssetLabel_assetId_fkey"
FOREIGN KEY ("assetId") REFERENCES "MediaAsset"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
