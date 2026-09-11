CREATE TABLE "BroadcastDestination" (
    "id" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "secretId" TEXT NOT NULL,
    "secretVersionId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "retiredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "BroadcastDestination_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "BroadcastDestinationSelection" (
    "id" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "programId" TEXT NOT NULL,
    "selectionHash" TEXT NOT NULL,
    "createdBySubject" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BroadcastDestinationSelection_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "BroadcastDestinationSelectionItem" (
    "id" TEXT NOT NULL,
    "selectionId" TEXT NOT NULL,
    "destinationId" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "secretId" TEXT NOT NULL,
    "secretVersionId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    CONSTRAINT "BroadcastDestinationSelectionItem_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "BroadcastDestinationCommand" (
    "id" TEXT NOT NULL,
    "programId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "selectionId" TEXT,
    "actorSubject" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "downstreamStatus" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "BroadcastDestinationCommand_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "BroadcastDestinationRuntime" (
    "programId" TEXT NOT NULL,
    "nextSequence" INTEGER NOT NULL DEFAULT 1,
    "requestedState" TEXT NOT NULL DEFAULT 'stopped',
    "actualState" TEXT NOT NULL DEFAULT 'unknown',
    "pendingSelectionId" TEXT,
    "activeSelectionId" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "BroadcastDestinationRuntime_pkey" PRIMARY KEY ("programId")
);

CREATE UNIQUE INDEX "BroadcastDestinationSelection_version_key" ON "BroadcastDestinationSelection"("version");
CREATE INDEX "BroadcastDestination_retiredAt_position_idx" ON "BroadcastDestination"("retiredAt", "position");
CREATE INDEX "BroadcastDestinationSelection_programId_createdAt_idx" ON "BroadcastDestinationSelection"("programId", "createdAt");
CREATE UNIQUE INDEX "BroadcastDestinationSelectionItem_selectionId_destinationId_key" ON "BroadcastDestinationSelectionItem"("selectionId", "destinationId");
CREATE INDEX "BroadcastDestinationSelectionItem_selectionId_position_idx" ON "BroadcastDestinationSelectionItem"("selectionId", "position");
CREATE UNIQUE INDEX "BroadcastDestinationCommand_programId_sequence_key" ON "BroadcastDestinationCommand"("programId", "sequence");
CREATE INDEX "BroadcastDestinationCommand_programId_createdAt_idx" ON "BroadcastDestinationCommand"("programId", "createdAt");
CREATE INDEX "BroadcastDestinationCommand_selectionId_idx" ON "BroadcastDestinationCommand"("selectionId");

ALTER TABLE "BroadcastDestinationSelection" ADD CONSTRAINT "BroadcastDestinationSelection_programId_fkey" FOREIGN KEY ("programId") REFERENCES "ProgramState"("programId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "BroadcastDestinationSelectionItem" ADD CONSTRAINT "BroadcastDestinationSelectionItem_selectionId_fkey" FOREIGN KEY ("selectionId") REFERENCES "BroadcastDestinationSelection"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "BroadcastDestinationCommand" ADD CONSTRAINT "BroadcastDestinationCommand_programId_fkey" FOREIGN KEY ("programId") REFERENCES "ProgramState"("programId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "BroadcastDestinationCommand" ADD CONSTRAINT "BroadcastDestinationCommand_selectionId_fkey" FOREIGN KEY ("selectionId") REFERENCES "BroadcastDestinationSelection"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
