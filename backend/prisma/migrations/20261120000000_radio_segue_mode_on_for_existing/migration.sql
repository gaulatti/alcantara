-- Turn segue, loudness and gapless handoff on for existing radio programs (gaulatti/alcantara#180).
-- RadioSettings.segueMode gates the segue and loudness data sent with each song and with the next-song
-- announcement Palazzo uses for gapless handoff. For radio programs (ProgramState type radio or both), every
-- settings row whose segueMode is not 'on' keeps its previous value in "segueModeBeforeDefaultOn" and is
-- set to 'on'. A row that already recorded a previous value is never rewritten, so running this again
-- changes nothing and never loses a recorded value. TV programs, and programs without radio settings,
-- are not touched.
-- Put-back: a forward migration that sets "segueMode" = "segueModeBeforeDefaultOn" where it is not null.
ALTER TABLE "RadioSettings" ADD COLUMN IF NOT EXISTS "segueModeBeforeDefaultOn" TEXT;

UPDATE "RadioSettings"
SET "segueModeBeforeDefaultOn" = "segueMode",
    "segueMode" = 'on'
WHERE "segueMode" <> 'on'
  AND "segueModeBeforeDefaultOn" IS NULL
  AND "programStateId" IN (SELECT "id" FROM "ProgramState" WHERE "type" IN ('radio', 'both'));
