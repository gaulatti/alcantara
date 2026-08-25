CREATE TABLE "SongIntro" (
    "id" SERIAL NOT NULL,
    "songId" INTEGER NOT NULL,
    "instantId" INTEGER NOT NULL,
    "programId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SongIntro_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SongIntro_songId_key" ON "SongIntro"("songId");
CREATE UNIQUE INDEX "SongIntro_instantId_key" ON "SongIntro"("instantId");
CREATE INDEX "SongIntro_programId_idx" ON "SongIntro"("programId");

ALTER TABLE "SongIntro"
ADD CONSTRAINT "SongIntro_songId_fkey"
FOREIGN KEY ("songId") REFERENCES "Song"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "SongIntro"
ADD CONSTRAINT "SongIntro_instantId_fkey"
FOREIGN KEY ("instantId") REFERENCES "Instant"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "SongIntro"
ADD CONSTRAINT "SongIntro_programId_fkey"
FOREIGN KEY ("programId") REFERENCES "ProgramState"("programId")
ON DELETE RESTRICT ON UPDATE CASCADE;
