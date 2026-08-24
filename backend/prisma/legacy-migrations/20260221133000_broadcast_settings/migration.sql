-- CreateTable
CREATE TABLE "BroadcastSettings" (
    "id" INTEGER NOT NULL PRIMARY KEY,
    "timeOverrideEnabled" BOOLEAN NOT NULL DEFAULT false,
    "timeOverrideStartTime" TEXT,
    "timeOverrideStartedAt" DATETIME,
    "updatedAt" DATETIME NOT NULL
);

