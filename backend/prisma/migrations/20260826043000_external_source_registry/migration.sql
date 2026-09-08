CREATE TABLE "ExternalSource" (
  "id" TEXT NOT NULL,
  "teamId" INTEGER NOT NULL,
  "name" TEXT NOT NULL,
  "transport" TEXT NOT NULL,
  "lifecycle" TEXT NOT NULL DEFAULT 'unconfigured',
  "health" TEXT NOT NULL DEFAULT 'unknown',
  "normalizationProfile" TEXT NOT NULL DEFAULT '720p30',
  "transportConfigCiphertext" TEXT NOT NULL,
  "transportConfigNonce" TEXT NOT NULL,
  "configKeyVersion" INTEGER NOT NULL,
  "credentialVersion" INTEGER NOT NULL DEFAULT 0,
  "ingressId" TEXT,
  "participantIdentity" TEXT,
  "lastConnectedAt" TIMESTAMP(3),
  "revokedAt" TIMESTAMP(3),
  "createdBySubject" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ExternalSource_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "ExternalSourceProgram" (
  "sourceId" TEXT NOT NULL,
  "programId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ExternalSourceProgram_pkey" PRIMARY KEY ("sourceId", "programId")
);
CREATE TABLE "ExternalSourceCredential" (
  "id" TEXT NOT NULL,
  "sourceId" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "secretHash" TEXT NOT NULL,
  "revokedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ExternalSourceCredential_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "Scene" ADD COLUMN "externalSourceId" TEXT;
CREATE INDEX "ExternalSource_teamId_lifecycle_idx" ON "ExternalSource"("teamId", "lifecycle");
CREATE INDEX "ExternalSource_transport_health_idx" ON "ExternalSource"("transport", "health");
CREATE INDEX "ExternalSourceProgram_programId_idx" ON "ExternalSourceProgram"("programId");
CREATE UNIQUE INDEX "ExternalSourceCredential_sourceId_version_key" ON "ExternalSourceCredential"("sourceId", "version");
CREATE INDEX "ExternalSourceCredential_sourceId_revokedAt_idx" ON "ExternalSourceCredential"("sourceId", "revokedAt");
CREATE INDEX "Scene_externalSourceId_idx" ON "Scene"("externalSourceId");
ALTER TABLE "ExternalSourceProgram" ADD CONSTRAINT "ExternalSourceProgram_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "ExternalSource"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ExternalSourceProgram" ADD CONSTRAINT "ExternalSourceProgram_programId_fkey" FOREIGN KEY ("programId") REFERENCES "ProgramState"("programId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ExternalSourceCredential" ADD CONSTRAINT "ExternalSourceCredential_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "ExternalSource"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Scene" ADD CONSTRAINT "Scene_externalSourceId_fkey" FOREIGN KEY ("externalSourceId") REFERENCES "ExternalSource"("id") ON DELETE SET NULL ON UPDATE CASCADE;
