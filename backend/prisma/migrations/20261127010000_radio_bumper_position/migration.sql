-- Where a program's station bumpers stand, so a restart keeps their cadence. No row: the count starts at zero, as before.
CREATE TABLE "RadioBumperPosition" (
    "programStateId" INTEGER NOT NULL,
    "songCount" INTEGER NOT NULL,
    "nextBumperIdx" INTEGER NOT NULL,
    "interval" INTEGER NOT NULL,
    "instantIds" INTEGER[],
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "RadioBumperPosition_pkey" PRIMARY KEY ("programStateId")
);
ALTER TABLE "RadioBumperPosition" ADD CONSTRAINT "RadioBumperPosition_programStateId_fkey" FOREIGN KEY ("programStateId") REFERENCES "ProgramState"("id") ON DELETE CASCADE ON UPDATE CASCADE;
