-- Screening before air: a guest waits until the operator admits them.
ALTER TABLE "GuestInvitation" ADD COLUMN "admittedAt" TIMESTAMP(3);
-- A guest connected while this deploys is already on their strip and stays there.
UPDATE "GuestInvitation" SET "admittedAt" = now() WHERE "activeSessionUntil" > now();
