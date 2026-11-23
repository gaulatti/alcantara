-- gaulatti/alcantara#236: an operator change record for on-air settings. Additive only: a new table,
-- written in the same transaction as the change. Existing rows are untouched.
CREATE TABLE "OperatorChangeRecord" (
    "id" TEXT NOT NULL,
    "teamId" INTEGER,
    "programId" TEXT NOT NULL,
    "principal" TEXT,
    "via" TEXT NOT NULL,
    "client" TEXT,
    "capability" TEXT NOT NULL,
    "summary" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OperatorChangeRecord_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "OperatorChangeRecord_teamId_idx" ON "OperatorChangeRecord"("teamId");
CREATE INDEX "OperatorChangeRecord_programId_createdAt_idx" ON "OperatorChangeRecord"("programId", "createdAt");
