ALTER TABLE "FlightSequence"
  ADD COLUMN "scheduledAt" TIMESTAMP(3),
  ADD COLUMN "publishedAt" TIMESTAMP(3),
  ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "lastStartedAt" TIMESTAMP(3);

CREATE UNIQUE INDEX "FlightSequence_programStateId_scheduledAt_key"
  ON "FlightSequence"("programStateId", "scheduledAt");

ALTER TABLE "RadioSettings"
  ADD COLUMN "fillerSongIds" INTEGER[] NOT NULL DEFAULT ARRAY[]::INTEGER[],
  ADD COLUMN "fillerVersion" TEXT;
