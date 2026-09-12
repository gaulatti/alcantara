-- Radio programs are audio-only. Remove obsolete visual assignments before
-- enforcing the ProgramState portion of that invariant.
UPDATE "ProgramState"
SET
  "templateUrl" = NULL,
  "templateManifest" = NULL,
  "templateVerifiedAt" = NULL,
  "activeSceneId" = NULL,
  "stagedSceneId" = NULL,
  "fadeToBlack" = false
WHERE "type" = 'radio';

DELETE FROM "ProgramScene"
WHERE "programStateId" IN (
  SELECT "id" FROM "ProgramState" WHERE "type" = 'radio'
);

DELETE FROM "ProgramMediaGroup"
WHERE "programStateId" IN (
  SELECT "id" FROM "ProgramState" WHERE "type" = 'radio'
);

DELETE FROM "ProgramStinger"
WHERE "programStateId" IN (
  SELECT "id" FROM "ProgramState" WHERE "type" = 'radio'
);

ALTER TABLE "ProgramState"
ADD CONSTRAINT "ProgramState_radio_visual_fields_check"
CHECK (
  "type" <> 'radio'
  OR (
    "templateUrl" IS NULL
    AND "templateManifest" IS NULL
    AND "templateVerifiedAt" IS NULL
    AND "activeSceneId" IS NULL
    AND "stagedSceneId" IS NULL
    AND "fadeToBlack" = false
  )
);
