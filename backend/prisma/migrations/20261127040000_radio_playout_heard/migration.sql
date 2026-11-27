-- What Palazzo last reported hearing on a program, so a backend that starts after a restart of both can tell that the
-- song on air then was cut. No row: nothing is claimed, as before.
CREATE TABLE "RadioPlayoutHeard" (
    "programStateId" INTEGER NOT NULL,
    "bootId" TEXT NOT NULL,
    "playbackRequestId" TEXT NOT NULL,
    "positionMs" INTEGER NOT NULL,
    "durationMs" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "artist" TEXT NOT NULL,
    "audioUrl" TEXT NOT NULL,
    "heardAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "RadioPlayoutHeard_pkey" PRIMARY KEY ("programStateId")
);
ALTER TABLE "RadioPlayoutHeard" ADD CONSTRAINT "RadioPlayoutHeard_programStateId_fkey" FOREIGN KEY ("programStateId") REFERENCES "ProgramState"("id") ON DELETE CASCADE ON UPDATE CASCADE;
