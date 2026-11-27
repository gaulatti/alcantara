-- The operator's cue on each guest, stored so the on-air contribution knows who is live. Additive: every
-- existing guest starts on standby, off air.
ALTER TABLE "GuestInvitation" ADD COLUMN "cue" TEXT NOT NULL DEFAULT 'standby';
ALTER TABLE "GuestInvitation" ADD COLUMN "cueSessionId" TEXT;
