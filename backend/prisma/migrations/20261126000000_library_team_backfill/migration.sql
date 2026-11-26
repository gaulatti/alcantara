-- gaulatti/alcantara#122: library rows written before they had a teamId (#148) belong to the only live customer, the
-- team that owns the modoitaliano.fm program (GM, 2026-11-26). The team is read from that program, never written here.
--
-- Only NULL teamId rows of the eleven shared libraries change, and updatedAt is left alone, so a second run updates
-- nothing. If the program has no row or no positive team, nothing changes. Each table's count goes to the database
-- server log. Audit tables and Program are not touched.
DO $$
DECLARE
  owner_team INTEGER;
  library TEXT;
  changed BIGINT;
BEGIN
  SELECT "teamId" INTO owner_team FROM "Program" WHERE "programId" = 'modoitaliano.fm';
  IF owner_team IS NULL OR owner_team <= 0 THEN
    RAISE LOG 'library_team_backfill: modoitaliano.fm has no team; nothing assigned';
    RETURN;
  END IF;
  FOREACH library IN ARRAY ARRAY[
    'BroadcastDestination', 'BroadcastSettings', 'Instant', 'Layout', 'Media', 'MediaAsset', 'MediaGroup',
    'MediaLabel', 'Scene', 'Song', 'Stinger'
  ] LOOP
    EXECUTE format('UPDATE %I SET "teamId" = $1 WHERE "teamId" IS NULL', library) USING owner_team;
    GET DIAGNOSTICS changed = ROW_COUNT;
    RAISE LOG 'library_team_backfill: assigned % rows of % to team %', changed, library, owner_team;
  END LOOP;
END $$;
