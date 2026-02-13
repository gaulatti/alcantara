-- CreateTable
CREATE TABLE "ProgramScene" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "programStateId" INTEGER NOT NULL,
    "sceneId" INTEGER NOT NULL,
    "position" INTEGER NOT NULL,
    CONSTRAINT "ProgramScene_programStateId_fkey" FOREIGN KEY ("programStateId") REFERENCES "ProgramState" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ProgramScene_sceneId_fkey" FOREIGN KEY ("sceneId") REFERENCES "Scene" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "ProgramScene_programStateId_sceneId_key" ON "ProgramScene"("programStateId", "sceneId");

-- CreateIndex
CREATE UNIQUE INDEX "ProgramScene_programStateId_position_key" ON "ProgramScene"("programStateId", "position");
