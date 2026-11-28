-- gaulatti/alcantara#124: clocks, a weekly daypart grid and the mark on rundowns made from a clock. All additive:
-- with no rows in "RadioDaypart" nothing is generated and the station behaves as before.
CREATE TABLE "RadioClock" (
    "id" SERIAL NOT NULL,
    "programStateId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "rules" JSONB NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "RadioClock_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "RadioClock_programStateId_name_key" ON "RadioClock"("programStateId", "name");
ALTER TABLE "RadioClock" ADD CONSTRAINT "RadioClock_programStateId_fkey" FOREIGN KEY ("programStateId") REFERENCES "ProgramState"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "RadioDaypartGrid" (
    "programStateId" INTEGER NOT NULL,
    "timeZone" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "RadioDaypartGrid_pkey" PRIMARY KEY ("programStateId")
);
ALTER TABLE "RadioDaypartGrid" ADD CONSTRAINT "RadioDaypartGrid_programStateId_fkey" FOREIGN KEY ("programStateId") REFERENCES "ProgramState"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "RadioDaypart" (
    "id" SERIAL NOT NULL,
    "programStateId" INTEGER NOT NULL,
    "dayOfWeek" INTEGER NOT NULL,
    "startHour" INTEGER NOT NULL,
    "endHour" INTEGER NOT NULL,
    "clockId" INTEGER NOT NULL,
    "start" TEXT NOT NULL DEFAULT 'soft',
    CONSTRAINT "RadioDaypart_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "RadioDaypart_hours_check" CHECK ("dayOfWeek" BETWEEN 0 AND 6 AND "startHour" >= 0 AND "endHour" <= 24 AND "startHour" < "endHour"),
    CONSTRAINT "RadioDaypart_start_check" CHECK ("start" IN ('soft', 'hard'))
);
CREATE UNIQUE INDEX "RadioDaypart_programStateId_dayOfWeek_startHour_key" ON "RadioDaypart"("programStateId", "dayOfWeek", "startHour");
ALTER TABLE "RadioDaypart" ADD CONSTRAINT "RadioDaypart_programStateId_fkey" FOREIGN KEY ("programStateId") REFERENCES "RadioDaypartGrid"("programStateId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RadioDaypart" ADD CONSTRAINT "RadioDaypart_clockId_fkey" FOREIGN KEY ("clockId") REFERENCES "RadioClock"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The clock a rundown was generated from; null for every rundown a person made. "daypartStart" is how it takes over.
ALTER TABLE "FlightSequence" ADD COLUMN "clockId" INTEGER;
ALTER TABLE "FlightSequence" ADD COLUMN "daypartStart" TEXT;
