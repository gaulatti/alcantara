-- CreateTable
CREATE TABLE "AsRunRecord" (
    "id" SERIAL NOT NULL,
    "programId" TEXT NOT NULL,
    "songId" INTEGER,
    "assetId" TEXT,
    "state" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AsRunRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AsRunRecord_programId_at_idx" ON "AsRunRecord"("programId", "at");
