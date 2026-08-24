CREATE TABLE IF NOT EXISTS "Media" (
  "id" SERIAL NOT NULL,
  "name" TEXT NOT NULL,
  "imageUrl" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Media_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "MediaGroup" (
  "id" SERIAL NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MediaGroup_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "MediaGroupItem" (
  "id" SERIAL NOT NULL,
  "mediaGroupId" INTEGER NOT NULL,
  "mediaId" INTEGER NOT NULL,
  "position" INTEGER NOT NULL,
  CONSTRAINT "MediaGroupItem_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "MediaGroupItem_mediaGroupId_fkey" FOREIGN KEY ("mediaGroupId") REFERENCES "MediaGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "MediaGroupItem_mediaId_fkey" FOREIGN KEY ("mediaId") REFERENCES "Media"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "MediaGroup_name_key" ON "MediaGroup"("name");
CREATE UNIQUE INDEX IF NOT EXISTS "MediaGroupItem_mediaGroupId_mediaId_key" ON "MediaGroupItem"("mediaGroupId", "mediaId");
CREATE UNIQUE INDEX IF NOT EXISTS "MediaGroupItem_mediaGroupId_position_key" ON "MediaGroupItem"("mediaGroupId", "position");
