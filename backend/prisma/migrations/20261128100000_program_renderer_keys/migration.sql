-- gaulatti/alcantara#884: one renderer key per program, kept only as its SHA-256. Additive: with no rows every caller
-- keeps using the shared key. Rollback: DROP TABLE "ProgramRendererKey";
CREATE TABLE "ProgramRendererKey" (
    "programStateId" INTEGER NOT NULL,
    "keyHash" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rotatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3),
    CONSTRAINT "ProgramRendererKey_pkey" PRIMARY KEY ("programStateId")
);
CREATE UNIQUE INDEX "ProgramRendererKey_keyHash_key" ON "ProgramRendererKey"("keyHash");
ALTER TABLE "ProgramRendererKey" ADD CONSTRAINT "ProgramRendererKey_programStateId_fkey" FOREIGN KEY ("programStateId") REFERENCES "ProgramState"("id") ON DELETE CASCADE ON UPDATE CASCADE;
