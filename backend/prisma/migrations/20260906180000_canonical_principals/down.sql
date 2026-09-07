-- Reverses 20260906180000_canonical_principals.
--
-- Only the added columns and indexes are dropped. Every legacy ownership and
-- audit value lives in the original subject columns, which this migration never
-- touched, so reverting cannot lose ownership or audit attribution.

DROP INDEX IF EXISTS "SharedConsoleLayout_ownerPrincipalId_idx";
DROP INDEX IF EXISTS "OperatorPreference_principalId_deviceClass_idx";

ALTER TABLE "GuestInvitation" DROP COLUMN IF EXISTS "createdByPrincipalId";
ALTER TABLE "SharedConsoleLayout" DROP COLUMN IF EXISTS "ownerPrincipalId";
ALTER TABLE "OperatorPreference" DROP COLUMN IF EXISTS "principalId";
