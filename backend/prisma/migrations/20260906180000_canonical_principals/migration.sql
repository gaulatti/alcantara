-- Canonical Pompeii principal references.
--
-- Additive and reversible on purpose: every column is nullable, no existing
-- value is rewritten, and no primary key moves. A pool subject cannot be mapped
-- to a canonical principal here — that requires a verified mapping from
-- Pompeii, which `principals-cli` applies separately — so this migration
-- backfills nothing.
--
-- Every statement is IF NOT EXISTS so a restart part-way through re-runs safely.

ALTER TABLE "OperatorPreference" ADD COLUMN IF NOT EXISTS "principalId" TEXT;
ALTER TABLE "SharedConsoleLayout" ADD COLUMN IF NOT EXISTS "ownerPrincipalId" TEXT;
ALTER TABLE "GuestInvitation" ADD COLUMN IF NOT EXISTS "createdByPrincipalId" TEXT;

CREATE INDEX IF NOT EXISTS "OperatorPreference_principalId_deviceClass_idx"
  ON "OperatorPreference" ("principalId", "deviceClass");
CREATE INDEX IF NOT EXISTS "SharedConsoleLayout_ownerPrincipalId_idx"
  ON "SharedConsoleLayout" ("ownerPrincipalId");
