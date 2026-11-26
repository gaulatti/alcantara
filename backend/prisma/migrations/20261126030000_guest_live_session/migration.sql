-- When the guest's call went live, until it ends: a session whose heartbeat stops while this is set was dropped.
ALTER TABLE "GuestInvitation" ADD COLUMN "liveSince" TIMESTAMP(3);
