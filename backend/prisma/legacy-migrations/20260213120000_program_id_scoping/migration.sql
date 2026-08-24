-- RedefineTable
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_ProgramState" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "programId" TEXT NOT NULL,
    "activeSceneId" INTEGER,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ProgramState_activeSceneId_fkey" FOREIGN KEY ("activeSceneId") REFERENCES "Scene" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_ProgramState" ("id", "programId", "activeSceneId", "updatedAt")
SELECT "id", 'main', "activeSceneId", "updatedAt" FROM "ProgramState";
DROP TABLE "ProgramState";
ALTER TABLE "new_ProgramState" RENAME TO "ProgramState";
CREATE UNIQUE INDEX "ProgramState_programId_key" ON "ProgramState"("programId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
