CREATE TABLE "GuestInvitation" (
  "id" TEXT NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "programId" TEXT NOT NULL,
  "displayName" TEXT NOT NULL,
  "slotNumber" INTEGER,
  "returnVideo" TEXT NOT NULL DEFAULT 'program',
  "returnAudioBus" TEXT NOT NULL DEFAULT 'master',
  "sourceGain" DOUBLE PRECISION NOT NULL DEFAULT 1,
  "sourceMuted" BOOLEAN NOT NULL DEFAULT false,
  "sourceDelayMs" INTEGER NOT NULL DEFAULT 0,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "revokedAt" TIMESTAMP(3),
  "activeSessionId" TEXT,
  "activeSessionUntil" TIMESTAMP(3),
  "createdByIdentity" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "GuestInvitation_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "GuestCommand" (
  "id" TEXT NOT NULL,
  "invitationId" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'requested',
  "failureReason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deliveredAt" TIMESTAMP(3),
  "acknowledgedAt" TIMESTAMP(3),
  CONSTRAINT "GuestCommand_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "GuestEvent" (
  "id" TEXT NOT NULL,
  "invitationId" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "details" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "GuestEvent_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "GuestInvitation_tokenHash_key" ON "GuestInvitation"("tokenHash");
CREATE INDEX "GuestInvitation_programId_expiresAt_idx" ON "GuestInvitation"("programId", "expiresAt");
CREATE UNIQUE INDEX "GuestInvitation_programId_slotNumber_key" ON "GuestInvitation"("programId", "slotNumber");
CREATE INDEX "GuestCommand_invitationId_createdAt_idx" ON "GuestCommand"("invitationId", "createdAt");
CREATE INDEX "GuestEvent_invitationId_createdAt_idx" ON "GuestEvent"("invitationId", "createdAt");
ALTER TABLE "GuestCommand" ADD CONSTRAINT "GuestCommand_invitationId_fkey" FOREIGN KEY ("invitationId") REFERENCES "GuestInvitation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GuestEvent" ADD CONSTRAINT "GuestEvent_invitationId_fkey" FOREIGN KEY ("invitationId") REFERENCES "GuestInvitation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
