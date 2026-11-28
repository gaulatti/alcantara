-- gaulatti/alcantara#124: what became of an hour made from a clock ('failed' or 'skipped', null otherwise) and the
-- revision the planner published, so a block a person has since edited is never taken back.
ALTER TABLE "FlightSequence" ADD COLUMN "daypartOutcome" TEXT;
ALTER TABLE "FlightSequence" ADD COLUMN "daypartRevision" INTEGER;
