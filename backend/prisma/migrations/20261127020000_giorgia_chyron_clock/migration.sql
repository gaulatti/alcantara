-- The legacy ModoItaliano chyron and clock retire (owner's decision, 2026-11-26). Every layout that lists them lists
-- the Giorgia chyron and clock instead, and every scene on such a layout carries its props over under the Giorgia
-- keys (the two take the same props). Additive: the legacy keys stay in each scene's metadata, and the console
-- still draws an old id with the Giorgia renderer. Idempotent: once no layout lists a legacy id, a second run
-- changes nothing.
DO $$
DECLARE
  scene RECORD;
  meta jsonb;
  updated jsonb;
BEGIN
  -- 1. Scenes first, while their layouts still name the legacy ids.
  FOR scene IN
    SELECT s.id, s.metadata
    FROM "Scene" s
    JOIN "Layout" l ON l.id = s."layoutId"
    WHERE string_to_array(replace(l."componentType", ' ', ''), ',')
          && ARRAY['modoitaliano-chyron', 'modoitaliano-clock']
  LOOP
    BEGIN
      meta := COALESCE(NULLIF(btrim(scene.metadata), ''), '{}')::jsonb;
    EXCEPTION WHEN others THEN
      -- Never fail the deploy on one scene: an unreadable metadata is left as it is, and the scene's Giorgia
      -- components start from their defaults.
      RAISE NOTICE 'scene % metadata is not JSON; left as it is', scene.id;
      CONTINUE;
    END;
    IF jsonb_typeof(meta) <> 'object' THEN
      CONTINUE;
    END IF;
    updated := meta;
    -- The props on air come from the legacy key the operator has been editing, so they win over any older
    -- Giorgia key left in the metadata.
    IF meta ? 'modoitaliano-chyron' THEN
      updated := jsonb_set(updated, '{modoitaliano-giorgia-chyron}', meta -> 'modoitaliano-chyron');
    END IF;
    IF meta ? 'modoitaliano-clock' THEN
      updated := jsonb_set(updated, '{modoitaliano-giorgia-clock}', meta -> 'modoitaliano-clock');
    END IF;
    IF updated IS DISTINCT FROM meta THEN
      UPDATE "Scene" SET metadata = updated::text, "updatedAt" = now() WHERE id = scene.id;
    END IF;
  END LOOP;

  -- 2. Then the layouts: each legacy id becomes its Giorgia id, in place, without listing a type twice.
  UPDATE "Layout" l
  SET "componentType" = (
        SELECT string_agg(swapped.type, ',' ORDER BY swapped.first_position)
        FROM (
          SELECT type, min(position) AS first_position
          FROM (
            SELECT CASE btrim(raw)
                     WHEN 'modoitaliano-chyron' THEN 'modoitaliano-giorgia-chyron'
                     WHEN 'modoitaliano-clock' THEN 'modoitaliano-giorgia-clock'
                     ELSE btrim(raw)
                   END AS type,
                   position
            FROM unnest(string_to_array(l."componentType", ',')) WITH ORDINALITY AS listed(raw, position)
            WHERE btrim(raw) <> ''
          ) mapped
          GROUP BY type
        ) swapped
      ),
      "updatedAt" = now()
  WHERE string_to_array(replace(l."componentType", ' ', ''), ',')
        && ARRAY['modoitaliano-chyron', 'modoitaliano-clock'];
END $$;
