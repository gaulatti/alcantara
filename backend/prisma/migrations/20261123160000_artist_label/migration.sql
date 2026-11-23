-- gaulatti/alcantara#423: attach a media label to an artist. Additive only.
CREATE TABLE "ArtistLabel" (
    "id" SERIAL NOT NULL,
    "artistKey" TEXT NOT NULL,
    "teamId" INTEGER,
    "artist" TEXT NOT NULL,
    "labelId" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ArtistLabel_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ArtistLabel_teamId_artistKey_key" ON "ArtistLabel"("teamId", "artistKey");
-- NULLs are distinct in a unique index, so a link with no team needs its own.
CREATE UNIQUE INDEX "ArtistLabel_artistKey_no_team_key" ON "ArtistLabel"("artistKey") WHERE "teamId" IS NULL;
CREATE INDEX "ArtistLabel_labelId_idx" ON "ArtistLabel"("labelId");

ALTER TABLE "ArtistLabel" ADD CONSTRAINT "ArtistLabel_labelId_fkey" FOREIGN KEY ("labelId") REFERENCES "MediaLabel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
