-- The next song Palazzo has accepted for a program, so the backend that takes over at a deploy keeps it instead of
-- announcing another: Palazzo drops a queued song as soon as it is given a replacement, before that one is ready.
-- No row: nothing is queued that the next backend should keep.
CREATE TABLE "RadioPlayoutAnnounced" (
    "programStateId" INTEGER NOT NULL,
    "announcement" JSONB NOT NULL,
    CONSTRAINT "RadioPlayoutAnnounced_pkey" PRIMARY KEY ("programStateId")
);
ALTER TABLE "RadioPlayoutAnnounced" ADD CONSTRAINT "RadioPlayoutAnnounced_programStateId_fkey" FOREIGN KEY ("programStateId") REFERENCES "ProgramState"("id") ON DELETE CASCADE ON UPDATE CASCADE;
