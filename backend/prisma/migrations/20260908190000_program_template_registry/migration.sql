ALTER TABLE "ProgramState"
ADD COLUMN "templateUrl" TEXT,
ADD COLUMN "templateManifest" JSONB,
ADD COLUMN "templateVerifiedAt" TIMESTAMP(3);
