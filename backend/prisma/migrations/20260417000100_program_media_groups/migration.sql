CREATE TABLE IF NOT EXISTS "ProgramMediaGroup" (
  "id" SERIAL NOT NULL,
  "programStateId" INTEGER NOT NULL,
  "mediaGroupId" INTEGER NOT NULL,
  "position" INTEGER NOT NULL,
  CONSTRAINT "ProgramMediaGroup_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ProgramMediaGroup_programStateId_fkey" FOREIGN KEY ("programStateId") REFERENCES "ProgramState"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ProgramMediaGroup_mediaGroupId_fkey" FOREIGN KEY ("mediaGroupId") REFERENCES "MediaGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "ProgramMediaGroup_programStateId_mediaGroupId_key"
ON "ProgramMediaGroup"("programStateId", "mediaGroupId");

CREATE UNIQUE INDEX IF NOT EXISTS "ProgramMediaGroup_programStateId_position_key"
ON "ProgramMediaGroup"("programStateId", "position");
