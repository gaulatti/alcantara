-- gaulatti/alcantara#122: rows written before they had a teamId (#148) belong to the only live customer (GM,
-- 2026-11-26). The team is not written here: it is the single distinct non-null teamId already in the tenant tables.
--
-- NULL teamId rows of the eleven shared libraries, Program and OperatorChangeRecord get that team; updatedAt is left
-- alone, so a second run finds no NULL and changes nothing. If there are rows to assign and the tables name no team,
-- or more than one, the migration FAILS: it never guesses. A database with nothing to assign (a new one) is left as it
-- is. Each table's count goes to the database server log. Other audit tables and ArtistLabel are not touched.
DO $$
DECLARE
  targets TEXT[] := ARRAY[
    'BroadcastDestination', 'BroadcastSettings', 'Instant', 'Layout', 'Media', 'MediaAsset', 'MediaGroup',
    'MediaLabel', 'Scene', 'Song', 'Stinger', 'Program', 'OperatorChangeRecord'
  ];
  tenant_tables TEXT[] := targets || ARRAY[
    'ExternalSource', 'ArtistLabel', 'BroadcastIngestAccess', 'BroadcastDestinationKeyChange'
  ];
  scoped TEXT;
  found INTEGER[] := ARRAY[]::INTEGER[];
  here INTEGER[];
  unassigned BOOLEAN := FALSE;
  has_null BOOLEAN;
  changed BIGINT;
BEGIN
  FOREACH scoped IN ARRAY targets LOOP
    EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I WHERE "teamId" IS NULL)', scoped) INTO has_null;
    unassigned := unassigned OR has_null;
  END LOOP;
  IF NOT unassigned THEN
    RETURN;
  END IF;

  FOREACH scoped IN ARRAY tenant_tables LOOP
    EXECUTE format('SELECT array_agg(DISTINCT "teamId") FROM %I WHERE "teamId" IS NOT NULL', scoped) INTO here;
    found := found || COALESCE(here, ARRAY[]::INTEGER[]);
  END LOOP;
  SELECT COALESCE(array_agg(DISTINCT team ORDER BY team), ARRAY[]::INTEGER[]) INTO found FROM unnest(found) AS team;
  IF cardinality(found) <> 1 OR found[1] <= 0 THEN
    RAISE EXCEPTION 'library_team_backfill: cannot tell which team owns the unassigned rows (teams found: %)', found;
  END IF;

  FOREACH scoped IN ARRAY targets LOOP
    EXECUTE format('UPDATE %I SET "teamId" = $1 WHERE "teamId" IS NULL', scoped) USING found[1];
    GET DIAGNOSTICS changed = ROW_COUNT;
    RAISE LOG 'library_team_backfill: assigned % rows of % to team %', changed, scoped, found[1];
  END LOOP;
END $$;
