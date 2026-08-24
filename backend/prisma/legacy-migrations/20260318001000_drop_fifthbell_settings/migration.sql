DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name = 'FifthBellSettings'
  ) THEN
    WITH legacy AS (
      SELECT
        "showArticles",
        "showWeather",
        "showEarthquakes",
        "showMarkets",
        "showMarquee",
        "showCallsignTake",
        COALESCE("weatherCitiesJson", '[]')::jsonb AS weather_cities
      FROM "FifthBellSettings"
      ORDER BY "id"
      LIMIT 1
    ),
    target_scene AS (
      SELECT
        s.id,
        COALESCE(NULLIF(s.metadata, ''), '{}')::jsonb AS metadata_json
      FROM "Scene" s
      INNER JOIN "Layout" l ON l.id = s."layoutId"
      WHERE l."componentType" = 'fifthbell'
      ORDER BY s.id
      LIMIT 1
    )
    UPDATE "Scene" s
    SET metadata = jsonb_set(
      target_scene.metadata_json,
      '{fifthbell}',
      COALESCE(target_scene.metadata_json->'fifthbell', '{}'::jsonb) || jsonb_build_object(
        'showArticles', legacy."showArticles",
        'showWeather', legacy."showWeather",
        'showEarthquakes', legacy."showEarthquakes",
        'showMarkets', legacy."showMarkets",
        'showMarquee', legacy."showMarquee",
        'showCallsignTake', legacy."showCallsignTake",
        'weatherCities', legacy.weather_cities
      ),
      true
    )::text
    FROM target_scene, legacy
    WHERE s.id = target_scene.id;
  END IF;
END $$;

DROP TABLE IF EXISTS "FifthBellSettings";
