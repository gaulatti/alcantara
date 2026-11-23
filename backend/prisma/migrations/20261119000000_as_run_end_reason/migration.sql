-- Additive only: a nullable column. Existing rows read NULL, so past records
-- and past royalty totals are unchanged.
ALTER TABLE "AsRunRecord" ADD COLUMN "endReason" TEXT;
