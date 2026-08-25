CREATE TABLE "OperatorPreference" (
    "subject" TEXT NOT NULL,
    "deviceClass" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "profile" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "OperatorPreference_pkey" PRIMARY KEY ("subject", "deviceClass")
);

CREATE TABLE "SharedConsoleLayout" (
    "id" TEXT NOT NULL,
    "ownerSubject" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "scope" TEXT NOT NULL,
    "scopeId" TEXT NOT NULL,
    "sourceDeviceClass" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "profile" JSONB NOT NULL,
    "retiredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SharedConsoleLayout_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "OperatorPreference_subject_idx" ON "OperatorPreference"("subject");
CREATE UNIQUE INDEX "SharedConsoleLayout_scope_scopeId_name_key" ON "SharedConsoleLayout"("scope", "scopeId", "name");
CREATE INDEX "SharedConsoleLayout_scope_scopeId_retiredAt_idx" ON "SharedConsoleLayout"("scope", "scopeId", "retiredAt");
CREATE INDEX "SharedConsoleLayout_ownerSubject_idx" ON "SharedConsoleLayout"("ownerSubject");
