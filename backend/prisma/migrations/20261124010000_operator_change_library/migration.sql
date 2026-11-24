-- gaulatti/alcantara#236: a change to something that belongs to no one program (a scene, a layout,
-- or a library item: an instant, stinger, song, media, media label or media group) is recorded with
-- no programId. Additive only: existing records keep their programId, and the column stays indexed.
ALTER TABLE "OperatorChangeRecord" ALTER COLUMN "programId" DROP NOT NULL;
