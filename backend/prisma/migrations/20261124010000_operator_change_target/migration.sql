-- gaulatti/alcantara#236 slice 2: scenes and layouts belong to no program, so a record may carry no program, and
-- every record can name the thing that changed. Additive: one NOT NULL dropped, two nullable columns added; existing
-- rows are untouched.
ALTER TABLE "OperatorChangeRecord" ALTER COLUMN "programId" DROP NOT NULL;
ALTER TABLE "OperatorChangeRecord" ADD COLUMN "targetKind" TEXT;
ALTER TABLE "OperatorChangeRecord" ADD COLUMN "targetId" TEXT;

CREATE INDEX "OperatorChangeRecord_targetKind_targetId_createdAt_idx" ON "OperatorChangeRecord"("targetKind", "targetId", "createdAt");
