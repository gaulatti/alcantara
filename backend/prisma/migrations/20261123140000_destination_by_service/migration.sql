-- gaulatti/alcantara#376: add a destination by service and key. Additive only: nullable columns
-- on BroadcastDestination (a row added by hand keeps working with them null) and an audit table.
ALTER TABLE "BroadcastDestination" ADD COLUMN "service" TEXT;
ALTER TABLE "BroadcastDestination" ADD COLUMN "ingestUrl" TEXT;
ALTER TABLE "BroadcastDestination" ADD COLUMN "keyLast4" TEXT;
ALTER TABLE "BroadcastDestination" ADD COLUMN "keySetAt" TIMESTAMP(3);

CREATE TABLE "BroadcastDestinationKeyChange" (
    "id" TEXT NOT NULL,
    "teamId" INTEGER,
    "destinationId" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BroadcastDestinationKeyChange_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "BroadcastDestinationKeyChange_teamId_idx" ON "BroadcastDestinationKeyChange"("teamId");
CREATE INDEX "BroadcastDestinationKeyChange_destinationId_createdAt_idx" ON "BroadcastDestinationKeyChange"("destinationId", "createdAt");
