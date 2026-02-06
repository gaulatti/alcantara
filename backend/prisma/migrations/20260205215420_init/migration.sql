-- CreateTable
CREATE TABLE "Layout" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "name" TEXT NOT NULL,
    "componentType" TEXT NOT NULL,
    "settings" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Scene" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "name" TEXT NOT NULL,
    "layoutId" INTEGER NOT NULL,
    "chyronText" TEXT,
    "metadata" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Scene_layoutId_fkey" FOREIGN KEY ("layoutId") REFERENCES "Layout" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ProgramState" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "activeSceneId" INTEGER,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ProgramState_activeSceneId_fkey" FOREIGN KEY ("activeSceneId") REFERENCES "Scene" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "Layout_name_key" ON "Layout"("name");
