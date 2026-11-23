-- Additive only: three nullable columns. Existing rows and automatic
-- transitions read NULL, so past records, exports and royalty totals are
-- unchanged (gaulatti/alcantara#213).
ALTER TABLE "AsRunRecord" ADD COLUMN "actorPrincipalId" TEXT;
ALTER TABLE "AsRunRecord" ADD COLUMN "actorVia" TEXT;
ALTER TABLE "AsRunRecord" ADD COLUMN "actorClient" TEXT;
