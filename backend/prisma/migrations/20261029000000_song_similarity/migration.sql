-- Additive. Requires the pgvector extension to be available on the server.
-- Rollback: DROP TABLE "SimilarityDecision", "SongEmbedding"; drop the added
-- RadioSettings/ProgramState columns; the extension may stay installed.
CREATE EXTENSION IF NOT EXISTS vector;

ALTER TABLE "ProgramState" ADD COLUMN "songArtistCycle" JSONB;

ALTER TABLE "RadioSettings"
  ADD COLUMN "similarityMode" TEXT NOT NULL DEFAULT 'off',
  ADD COLUMN "similarityThreshold" DOUBLE PRECISION NOT NULL DEFAULT 0.8,
  ADD COLUMN "similarityWindowSeconds" INTEGER NOT NULL DEFAULT 30,
  ADD COLUMN "similarityPool" TEXT NOT NULL DEFAULT 'sequence';

CREATE TABLE "SongEmbedding" (
  "id" SERIAL NOT NULL,
  "songId" INTEGER NOT NULL,
  "segment" TEXT NOT NULL,
  "model" TEXT NOT NULL,
  "modelVersion" TEXT NOT NULL,
  "license" TEXT NOT NULL,
  "windowSeconds" INTEGER NOT NULL,
  "audioSha256" TEXT NOT NULL,
  "vector" vector NOT NULL,
  "computedAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SongEmbedding_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SongEmbedding_songId_fkey" FOREIGN KEY ("songId") REFERENCES "Song"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "SongEmbedding_songId_segment_model_windowSeconds_key" ON "SongEmbedding"("songId", "segment", "model", "windowSeconds");
CREATE INDEX "SongEmbedding_model_windowSeconds_idx" ON "SongEmbedding"("model", "windowSeconds");

CREATE TABLE "SimilarityDecision" (
  "id" SERIAL NOT NULL,
  "programId" TEXT NOT NULL,
  "mode" TEXT NOT NULL,
  "outcome" TEXT NOT NULL,
  "currentSongId" INTEGER,
  "proposedSongId" INTEGER,
  "playedSongId" INTEGER,
  "score" DOUBLE PRECISION,
  "runnerUps" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SimilarityDecision_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "SimilarityDecision_programId_createdAt_idx" ON "SimilarityDecision"("programId", "createdAt");
