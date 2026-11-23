-- segueMode defaults to on for radio settings created from now on (gaulatti/alcantara#164).
-- Default change only: existing RadioSettings rows keep their stored segueMode.
ALTER TABLE "RadioSettings" ALTER COLUMN "segueMode" SET DEFAULT 'on';
