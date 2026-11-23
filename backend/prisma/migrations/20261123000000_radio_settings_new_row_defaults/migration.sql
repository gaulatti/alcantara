-- New rows only: the column defaults for new RadioSettings rows match what production
-- runs (similarityMode 'on', bumperEnabled true). No existing row is updated here; each
-- station keeps the value it has, including 'off' and false.
ALTER TABLE "RadioSettings" ALTER COLUMN "bumperEnabled" SET DEFAULT true;
ALTER TABLE "RadioSettings" ALTER COLUMN "similarityMode" SET DEFAULT 'on';
