-- CreateTable
CREATE TABLE "FlightSequence" (
    "id" SERIAL NOT NULL,
    "programStateId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "items" JSONB NOT NULL,
    "loop" BOOLEAN NOT NULL DEFAULT false,
    "isRunning" BOOLEAN NOT NULL DEFAULT false,
    "activeItemId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FlightSequence_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "FlightSequence_programStateId_name_key" ON "FlightSequence"("programStateId", "name");

-- AddForeignKey
ALTER TABLE "FlightSequence" ADD CONSTRAINT "FlightSequence_programStateId_fkey" FOREIGN KEY ("programStateId") REFERENCES "ProgramState"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable
ALTER TABLE "ProgramState" ADD COLUMN "activeFlightSequenceId" INTEGER;
