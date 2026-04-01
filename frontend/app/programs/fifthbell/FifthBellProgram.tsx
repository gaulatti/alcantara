import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSSE } from '../../hooks/useSSE';
import { apiUrl } from '../../utils/apiBaseUrl';
import { FIFTHBELL_ASSETS } from './assets';
import { MarqueeCurtain } from './components/MarqueeCurtain';
import Marquee from './components/Marquee';
import { DEFAULT_WORLD_CLOCK_CITIES } from './components/WorldClocks';
import { CallsignSlide } from './components/slides/CallsignSlide';
import { slideStyles } from './components/slides/slideStyles';
import { fetchEvents, getCachedEvents, hasEventChanges, type Event } from './events';
import { type SupportedLanguage } from './i18n';
import {
  createArticlesSegment,
  createEarthquakeSegment,
  createMarketsSegment,
  createWeatherSegment,
  fetchArticles,
  fetchEarthquakes,
  fetchMarketData,
  fetchWeatherData,
  type EarthquakeData,
  type MarketData,
  type NewsItem,
  type WeatherRegionData,
  usePlaylistEngine
} from './segments';

interface Layout {
  id: number;
  name: string;
  componentType: string;
  settings: string;
}

interface Scene {
  id: number;
  name: string;
  layoutId: number;
  layout: Layout;
  chyronText: string | null;
  metadata: string | null;
}

interface ProgramState {
  id: number;
  activeSceneId: number | null;
  activeScene: Scene | null;
  updatedAt: string;
}

interface FifthBellWorldClockCity {
  city: string;
  timezone: string;
}

interface FifthBellProgramProps {
  programId?: string;
  embedded?: boolean;
  sceneMetadata?: Record<string, unknown> | null;
  activeComponents?: string[];
}

interface FifthBellConfig {
  showArticles: boolean;
  showWeather: boolean;
  showEarthquakes: boolean;
  showMarkets: boolean;
  showMarquee: boolean;
  showCallsignTake: boolean;
  weatherCities: string[];
  languageRotation: SupportedLanguage[];
  dataLoadTimeoutMs: number;
  playlistDefaultDurationMs: number;
  playlistUpdateIntervalMs: number;
  articlesDurationMs: number;
  weatherDurationMs: number;
  earthquakesDurationMs: number;
  marketsDurationMs: number;
  showWorldClocks: boolean;
  showBellIcon: boolean;
  worldClockRotateIntervalMs: number;
  worldClockTransitionMs: number;
  worldClockShuffle: boolean;
  worldClockWidthPx: number;
  worldClockCities: FifthBellWorldClockCity[];
  audioCueEnabled: boolean;
  audioCueMinute: number;
  audioCueSecond: number;
  callsignPrelaunchUntilNyc: string;
  callsignWindowStartSecond: number;
  callsignWindowEndSecond: number;
  marqueeMinPostsCount: number;
  marqueeMinAverageRelevance: number;
  marqueeMinMedianRelevance: number;
  marqueePixelsPerSecond: number;
  marqueeMinDurationSeconds: number;
  marqueeHeightPx: number;
}

const DEFAULT_LANGUAGE_ROTATION: SupportedLanguage[] = ['en', 'es', 'en', 'it'];
const DEFAULT_CALLSIGN_PRELAUNCH_UNTIL_NYC = '2026-01-02T21:30:00';
const FIFTHBELL_COMPONENT_TYPE_CONTENT = 'fifthbell-content';
const FIFTHBELL_COMPONENT_TYPE_MARQUEE = 'fifthbell-marquee';
const FIFTHBELL_COMPONENT_TYPE_TONI_CLOCK = 'toni-clock';
const FIFTHBELL_COMPONENT_TYPE_CORNER = 'fifthbell-corner';
const FIFTHBELL_COMPONENT_TYPE_LEGACY = 'fifthbell';

const DEFAULT_FIFTHBELL_CONFIG: FifthBellConfig = {
  showArticles: true,
  showWeather: true,
  showEarthquakes: true,
  showMarkets: true,
  showMarquee: false,
  showCallsignTake: true,
  weatherCities: [],
  languageRotation: DEFAULT_LANGUAGE_ROTATION,
  dataLoadTimeoutMs: 15000,
  playlistDefaultDurationMs: 10000,
  playlistUpdateIntervalMs: 100,
  articlesDurationMs: 10000,
  weatherDurationMs: 5000,
  earthquakesDurationMs: 10000,
  marketsDurationMs: 10000,
  showWorldClocks: true,
  showBellIcon: true,
  worldClockRotateIntervalMs: 7000,
  worldClockTransitionMs: 300,
  worldClockShuffle: true,
  worldClockWidthPx: 200,
  worldClockCities: [...DEFAULT_WORLD_CLOCK_CITIES],
  audioCueEnabled: true,
  audioCueMinute: 59,
  audioCueSecond: 55,
  callsignPrelaunchUntilNyc: DEFAULT_CALLSIGN_PRELAUNCH_UNTIL_NYC,
  callsignWindowStartSecond: 50,
  callsignWindowEndSecond: 3,
  marqueeMinPostsCount: 4,
  marqueeMinAverageRelevance: 0,
  marqueeMinMedianRelevance: 0,
  marqueePixelsPerSecond: 150,
  marqueeMinDurationSeconds: 10,
  marqueeHeightPx: 72
};

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, numeric));
}

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'number') {
    return value !== 0;
  }

  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(normalized)) {
      return true;
    }
    if (['false', '0', 'no', 'off', ''].includes(normalized)) {
      return false;
    }
  }

  return fallback;
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const deduped = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string') {
      continue;
    }

    const trimmed = item.trim();
    if (!trimmed) {
      continue;
    }

    deduped.add(trimmed);
  }

  return [...deduped];
}

function normalizeLanguageRotation(value: unknown): SupportedLanguage[] {
  if (!Array.isArray(value)) {
    return [...DEFAULT_LANGUAGE_ROTATION];
  }

  const allowed = new Set<SupportedLanguage>(['en', 'es', 'it']);
  const filtered = value.filter((item): item is SupportedLanguage => typeof item === 'string' && allowed.has(item as SupportedLanguage));

  return filtered.length > 0 ? filtered : [...DEFAULT_LANGUAGE_ROTATION];
}

function normalizeWorldClockCities(value: unknown): FifthBellWorldClockCity[] {
  if (!Array.isArray(value)) {
    return [...DEFAULT_WORLD_CLOCK_CITIES];
  }

  const normalized = value
    .map((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        return null;
      }

      const city = typeof item.city === 'string' ? item.city.trim() : '';
      const timezone = typeof item.timezone === 'string' ? item.timezone.trim() : '';
      if (!city || !timezone) {
        return null;
      }

      return { city, timezone };
    })
    .filter((item): item is FifthBellWorldClockCity => item !== null);

  return normalized.length > 0 ? normalized : [...DEFAULT_WORLD_CLOCK_CITIES];
}

function normalizeCityKey(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase();
}

function toRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function parseSceneMetadata(scene: Scene | null): Record<string, unknown> {
  if (!scene || !scene.metadata) {
    return {};
  }

  try {
    const parsed = JSON.parse(scene.metadata);
    return toRecord(parsed);
  } catch {
    return {};
  }
}

function resolveFifthBellLayerAvailability(activeComponents?: string[]) {
  const defaultAvailability = {
    content: true,
    marquee: true
  };

  if (!activeComponents || activeComponents.length === 0) {
    return defaultAvailability;
  }

  if (activeComponents.includes(FIFTHBELL_COMPONENT_TYPE_LEGACY)) {
    return defaultAvailability;
  }

  return {
    content: activeComponents.includes(FIFTHBELL_COMPONENT_TYPE_CONTENT),
    marquee: activeComponents.includes(FIFTHBELL_COMPONENT_TYPE_MARQUEE)
  };
}

function extractConfigFromMetadata(metadataInput: Record<string, unknown> | null | undefined): FifthBellConfig {
  const metadata = toRecord(metadataInput);
  const legacyProps = toRecord(metadata[FIFTHBELL_COMPONENT_TYPE_LEGACY]);
  const contentProps = {
    ...legacyProps,
    ...toRecord(metadata[FIFTHBELL_COMPONENT_TYPE_CONTENT])
  };
  const marqueeProps = {
    ...legacyProps,
    ...toRecord(metadata[FIFTHBELL_COMPONENT_TYPE_MARQUEE])
  };
  const cornerProps = {
    ...legacyProps,
    ...toRecord(metadata[FIFTHBELL_COMPONENT_TYPE_TONI_CLOCK]),
    ...toRecord(metadata[FIFTHBELL_COMPONENT_TYPE_CORNER])
  };

  const parsedMarqueeMinPostsCount = clampNumber(marqueeProps.marqueeMinPostsCount, DEFAULT_FIFTHBELL_CONFIG.marqueeMinPostsCount, 0, 50);
  let parsedMarqueeMinAverageRelevance = clampNumber(marqueeProps.marqueeMinAverageRelevance, DEFAULT_FIFTHBELL_CONFIG.marqueeMinAverageRelevance, 0, 100);
  let parsedMarqueeMinMedianRelevance = clampNumber(marqueeProps.marqueeMinMedianRelevance, DEFAULT_FIFTHBELL_CONFIG.marqueeMinMedianRelevance, 0, 100);

  // Compatibility: prior defaults were tuned for OR logic. Under threshold logic, treat that trio as legacy.
  if (parsedMarqueeMinPostsCount === 4 && parsedMarqueeMinAverageRelevance === 5 && parsedMarqueeMinMedianRelevance === 7) {
    parsedMarqueeMinAverageRelevance = 0;
    parsedMarqueeMinMedianRelevance = 0;
  }

  return {
    showArticles: normalizeBoolean(contentProps.showArticles, DEFAULT_FIFTHBELL_CONFIG.showArticles),
    showWeather: normalizeBoolean(contentProps.showWeather, DEFAULT_FIFTHBELL_CONFIG.showWeather),
    showEarthquakes: normalizeBoolean(contentProps.showEarthquakes, DEFAULT_FIFTHBELL_CONFIG.showEarthquakes),
    showMarkets: normalizeBoolean(contentProps.showMarkets, DEFAULT_FIFTHBELL_CONFIG.showMarkets),
    showMarquee: normalizeBoolean(marqueeProps.showMarquee, DEFAULT_FIFTHBELL_CONFIG.showMarquee),
    showCallsignTake: normalizeBoolean(contentProps.showCallsignTake, DEFAULT_FIFTHBELL_CONFIG.showCallsignTake),
    weatherCities: normalizeStringArray(contentProps.weatherCities),
    languageRotation: normalizeLanguageRotation(contentProps.languageRotation),
    dataLoadTimeoutMs: clampNumber(contentProps.dataLoadTimeoutMs, DEFAULT_FIFTHBELL_CONFIG.dataLoadTimeoutMs, 1000, 120000),
    playlistDefaultDurationMs: clampNumber(contentProps.playlistDefaultDurationMs, DEFAULT_FIFTHBELL_CONFIG.playlistDefaultDurationMs, 1000, 120000),
    playlistUpdateIntervalMs: clampNumber(contentProps.playlistUpdateIntervalMs, DEFAULT_FIFTHBELL_CONFIG.playlistUpdateIntervalMs, 16, 5000),
    articlesDurationMs: clampNumber(contentProps.articlesDurationMs, DEFAULT_FIFTHBELL_CONFIG.articlesDurationMs, 1000, 120000),
    weatherDurationMs: clampNumber(contentProps.weatherDurationMs, DEFAULT_FIFTHBELL_CONFIG.weatherDurationMs, 1000, 120000),
    earthquakesDurationMs: clampNumber(contentProps.earthquakesDurationMs, DEFAULT_FIFTHBELL_CONFIG.earthquakesDurationMs, 1000, 120000),
    marketsDurationMs: clampNumber(contentProps.marketsDurationMs, DEFAULT_FIFTHBELL_CONFIG.marketsDurationMs, 1000, 120000),
    showWorldClocks: normalizeBoolean(cornerProps.showWorldClocks, DEFAULT_FIFTHBELL_CONFIG.showWorldClocks),
    showBellIcon: true,
    worldClockRotateIntervalMs: clampNumber(cornerProps.worldClockRotateIntervalMs, DEFAULT_FIFTHBELL_CONFIG.worldClockRotateIntervalMs, 500, 120000),
    worldClockTransitionMs: clampNumber(cornerProps.worldClockTransitionMs, DEFAULT_FIFTHBELL_CONFIG.worldClockTransitionMs, 0, 10000),
    worldClockShuffle: normalizeBoolean(cornerProps.worldClockShuffle, DEFAULT_FIFTHBELL_CONFIG.worldClockShuffle),
    worldClockWidthPx: clampNumber(cornerProps.worldClockWidthPx, DEFAULT_FIFTHBELL_CONFIG.worldClockWidthPx, 120, 600),
    worldClockCities: normalizeWorldClockCities(cornerProps.worldClockCities),
    audioCueEnabled: normalizeBoolean(contentProps.audioCueEnabled, DEFAULT_FIFTHBELL_CONFIG.audioCueEnabled),
    audioCueMinute: clampNumber(contentProps.audioCueMinute, DEFAULT_FIFTHBELL_CONFIG.audioCueMinute, 0, 59),
    audioCueSecond: clampNumber(contentProps.audioCueSecond, DEFAULT_FIFTHBELL_CONFIG.audioCueSecond, 0, 59),
    callsignPrelaunchUntilNyc:
      typeof contentProps.callsignPrelaunchUntilNyc === 'string' && contentProps.callsignPrelaunchUntilNyc.trim()
        ? contentProps.callsignPrelaunchUntilNyc.trim()
        : DEFAULT_FIFTHBELL_CONFIG.callsignPrelaunchUntilNyc,
    callsignWindowStartSecond: clampNumber(contentProps.callsignWindowStartSecond, DEFAULT_FIFTHBELL_CONFIG.callsignWindowStartSecond, 0, 59),
    callsignWindowEndSecond: clampNumber(contentProps.callsignWindowEndSecond, DEFAULT_FIFTHBELL_CONFIG.callsignWindowEndSecond, 0, 59),
    marqueeMinPostsCount: parsedMarqueeMinPostsCount,
    marqueeMinAverageRelevance: parsedMarqueeMinAverageRelevance,
    marqueeMinMedianRelevance: parsedMarqueeMinMedianRelevance,
    marqueePixelsPerSecond: clampNumber(marqueeProps.marqueePixelsPerSecond, DEFAULT_FIFTHBELL_CONFIG.marqueePixelsPerSecond, 10, 1000),
    marqueeMinDurationSeconds: clampNumber(marqueeProps.marqueeMinDurationSeconds, DEFAULT_FIFTHBELL_CONFIG.marqueeMinDurationSeconds, 1, 120),
    marqueeHeightPx: clampNumber(marqueeProps.marqueeHeightPx, DEFAULT_FIFTHBELL_CONFIG.marqueeHeightPx, 72, 200)
  };
}

function normalizeLaunchDate(rawDate: string): Date {
  const parsed = new Date(rawDate);
  if (Number.isNaN(parsed.getTime())) {
    return new Date(DEFAULT_CALLSIGN_PRELAUNCH_UNTIL_NYC);
  }

  return parsed;
}

export default function FifthBellProgram({ programId = 'fifthbell', embedded = false, sceneMetadata, activeComponents }: FifthBellProgramProps) {
  const encodedProgramId = encodeURIComponent(programId);
  const [state, setState] = useState<ProgramState | null>(null);
  const [showLogoSlide, setShowLogoSlide] = useState(false);
  const [callsignTime, setCallsignTime] = useState(new Date());
  const audioRef = useRef<HTMLAudioElement>(null);
  const audioInitialized = useRef(false);

  const [languageIndex, setLanguageIndex] = useState(0);

  const [articles, setArticles] = useState<NewsItem[]>([]);
  const [weatherData, setWeatherData] = useState<WeatherRegionData[]>([]);
  const [earthquakes, setEarthquakes] = useState<EarthquakeData[]>([]);
  const [markets, setMarkets] = useState<MarketData[]>([]);

  const [stageEvents, setStageEvents] = useState<Event[]>([]);
  const [programEvents, setProgramEvents] = useState<Event[]>([]);
  const [showCurtain, setShowCurtain] = useState(false);
  const [updatePending, setUpdatePending] = useState(false);
  const updatePendingRef = useRef(false);
  const [dataLoaded, setDataLoaded] = useState(false);
  const lastFetchedItemRef = useRef<number>(-1);

  const controlledBySceneRenderer = sceneMetadata !== undefined;
  const effectiveSceneMetadata = useMemo(() => {
    if (sceneMetadata !== undefined) {
      return toRecord(sceneMetadata);
    }

    return parseSceneMetadata(state?.activeScene ?? null);
  }, [sceneMetadata, state?.activeScene]);
  const config = useMemo(() => extractConfigFromMetadata(effectiveSceneMetadata), [effectiveSceneMetadata]);
  const layerAvailability = useMemo(() => resolveFifthBellLayerAvailability(activeComponents), [activeComponents]);
  const languageRotation = config.languageRotation;
  const currentLanguage: SupportedLanguage = languageRotation[languageIndex] ?? languageRotation[0] ?? 'en';

  useEffect(() => {
    if (languageIndex >= languageRotation.length) {
      setLanguageIndex(0);
    }
  }, [languageIndex, languageRotation.length]);

  useEffect(() => {
    updatePendingRef.current = updatePending;
  }, [updatePending]);

  useEffect(() => {
    if (controlledBySceneRenderer) {
      return;
    }

    fetch(apiUrl(`/program/${encodedProgramId}/state`))
      .then((res) => res.json())
      .then((data) => setState(data))
      .catch((err) => console.error('Failed to fetch FifthBell program state:', err));
  }, [controlledBySceneRenderer, encodedProgramId]);

  const refreshAllData = useCallback(async () => {
    const [articlesData, weatherDataResult, earthquakesData, marketsData] = await Promise.all([
      fetchArticles(currentLanguage),
      fetchWeatherData(),
      fetchEarthquakes(currentLanguage),
      fetchMarketData(),
      fetchEvents({
        language: currentLanguage,
        allowedLanguages: [currentLanguage]
      })
    ]);

    setArticles(articlesData);
    setWeatherData(weatherDataResult);
    setEarthquakes(earthquakesData);
    setMarkets(marketsData);

    const cachedEvents = getCachedEvents();
    if (cachedEvents) {
      setStageEvents(cachedEvents);
      setProgramEvents(cachedEvents);
    }

    setDataLoaded(true);
  }, [currentLanguage]);

  useEffect(() => {
    void refreshAllData();
  }, [refreshAllData]);

  useSSE({
    url: apiUrl(`/program/${encodedProgramId}/events`),
    enabled: !controlledBySceneRenderer,
    onMessage: (data) => {
      if ((data.type === 'scene_change' || data.type === 'program_scenes_changed') && data.state) {
        setState(data.state);
      } else if (data.type === 'scene_update') {
        setState((prev) => {
          if (!prev) return prev;
          return {
            ...prev,
            activeScene: data.scene ?? prev.activeScene
          };
        });
      } else if (data.type === 'scene_cleared') {
        setState((prev) => {
          if (!prev) return prev;
          return {
            ...prev,
            activeSceneId: null,
            activeScene: null
          };
        });
      }
    }
  });

  useEffect(() => {
    if (dataLoaded || config.dataLoadTimeoutMs <= 0) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      window.location.reload();
    }, config.dataLoadTimeoutMs);

    return () => window.clearTimeout(timeoutId);
  }, [dataLoaded, config.dataLoadTimeoutMs]);

  const refreshEvents = useCallback(async () => {
    await fetchEvents({
      language: currentLanguage,
      allowedLanguages: [currentLanguage]
    });
    const cachedEvents = getCachedEvents();
    if (!cachedEvents) {
      return;
    }

    setStageEvents((prevStage) => {
      const prevJson = JSON.stringify(prevStage);
      const nextJson = JSON.stringify(cachedEvents);
      return prevJson === nextJson ? prevStage : cachedEvents;
    });
  }, [currentLanguage]);

  useEffect(() => {
    if (stageEvents.length > 0 && programEvents.length > 0 && hasEventChanges(programEvents, stageEvents) && !showCurtain && !updatePending) {
      setUpdatePending(true);
    }
  }, [programEvents, showCurtain, stageEvents, updatePending]);

  const handleMarqueeCycleComplete = useCallback(() => {
    if (updatePendingRef.current) {
      setShowCurtain(true);
      setUpdatePending(false);
    }
  }, []);

  const handleCurtainComplete = useCallback(() => {
    setProgramEvents(stageEvents);
    setShowCurtain(false);
  }, [stageEvents]);

  const handlePlaylistLoop = useCallback(() => {
    setLanguageIndex((prev) => (prev + 1) % Math.max(1, languageRotation.length));
  }, [languageRotation.length]);

  const articlesSegment = useMemo(() => {
    const segment = createArticlesSegment(articles, setArticles, currentLanguage);
    segment.durationMsPerItem = config.articlesDurationMs;
    const originalRender = segment.render;
    const originalOnEnter = segment.onEnter;

    segment.onEnter = () => {
      originalOnEnter?.();
      lastFetchedItemRef.current = -1;
    };

    segment.render = (itemIndex: number, progress: number) => {
      if (lastFetchedItemRef.current !== itemIndex) {
        lastFetchedItemRef.current = itemIndex;
        void refreshEvents();
      }
      return originalRender(itemIndex, progress);
    };

    return segment;
  }, [articles, currentLanguage, refreshEvents, config.articlesDurationMs]);

  const filteredWeatherData = useMemo(() => {
    if (!config.weatherCities || config.weatherCities.length === 0) {
      return weatherData;
    }

    const allowed = new Set(config.weatherCities.map(normalizeCityKey));
    return weatherData
      .map((region) => ({
        ...region,
        cities: region.cities.filter((city) => allowed.has(normalizeCityKey(city.name)))
      }))
      .filter((region) => region.cities.length > 0);
  }, [config.weatherCities, weatherData]);

  const weatherSegment = useMemo(() => {
    const segment = createWeatherSegment(filteredWeatherData, setWeatherData, currentLanguage);
    segment.durationMsPerItem = config.weatherDurationMs;
    return segment;
  }, [filteredWeatherData, setWeatherData, currentLanguage, config.weatherDurationMs]);

  const earthquakeSegment = useMemo(() => {
    const segment = createEarthquakeSegment(earthquakes, setEarthquakes, currentLanguage);
    segment.durationMsPerItem = config.earthquakesDurationMs;
    return segment;
  }, [earthquakes, setEarthquakes, currentLanguage, config.earthquakesDurationMs]);

  const marketsSegment = useMemo(() => {
    const segment = createMarketsSegment(markets, setMarkets, currentLanguage);
    segment.durationMsPerItem = config.marketsDurationMs;
    return segment;
  }, [markets, setMarkets, currentLanguage, config.marketsDurationMs]);

  const segments = useMemo(() => {
    const nextSegments = [];
    if (config.showArticles) nextSegments.push(articlesSegment);
    if (config.showWeather) nextSegments.push(weatherSegment);
    if (config.showEarthquakes) nextSegments.push(earthquakeSegment);
    if (config.showMarkets) nextSegments.push(marketsSegment);
    return nextSegments;
  }, [articlesSegment, weatherSegment, earthquakeSegment, marketsSegment, config.showArticles, config.showWeather, config.showEarthquakes, config.showMarkets]);

  const {
    state: playlistState,
    currentSegment,
    pause,
    resume,
    reset
  } = usePlaylistEngine({
    segments,
    defaultDurationMs: config.playlistDefaultDurationMs,
    updateIntervalMs: config.playlistUpdateIntervalMs,
    onPlaylistLoop: handlePlaylistLoop
  });

  useEffect(() => {
    if (!audioRef.current || audioInitialized.current) {
      return;
    }

    audioRef.current.load();
    audioInitialized.current = true;
  }, []);

  useEffect(() => {
    if (!config.audioCueEnabled) {
      return;
    }

    const interval = window.setInterval(() => {
      const now = new Date();
      if (now.getMinutes() === config.audioCueMinute && now.getSeconds() === config.audioCueSecond && audioRef.current) {
        audioRef.current.currentTime = 0;
        void audioRef.current.play().catch((error) => {
          console.log('Audio playback prevented:', error);
        });
      }
    }, 1000);

    return () => window.clearInterval(interval);
  }, [config.audioCueEnabled, config.audioCueMinute, config.audioCueSecond]);

  useEffect(() => {
    const checkTime = () => {
      const now = new Date();
      const minutes = now.getMinutes();
      const seconds = now.getSeconds();

      const nycTime = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
      const launchDateNyc = new Date(normalizeLaunchDate(config.callsignPrelaunchUntilNyc).toLocaleString('en-US', { timeZone: 'America/New_York' }));
      const isBeforeLaunch = nycTime < launchDateNyc;
      const withinScheduleWindow =
        (minutes === 59 && seconds >= config.callsignWindowStartSecond) || (minutes === 0 && seconds <= config.callsignWindowEndSecond);

      const shouldShow = config.showCallsignTake && (isBeforeLaunch || withinScheduleWindow);
      if (shouldShow && !showLogoSlide) {
        reset();
      }

      setShowLogoSlide(shouldShow);
      if (shouldShow) {
        setCallsignTime(now);
      }
    };

    checkTime();
    const timer = window.setInterval(checkTime, 1000);
    return () => window.clearInterval(timer);
  }, [reset, config.showCallsignTake, config.callsignPrelaunchUntilNyc, config.callsignWindowStartSecond, config.callsignWindowEndSecond, showLogoSlide]);

  useEffect(() => {
    if (showLogoSlide) {
      pause();
    } else if (playlistState.isPaused) {
      resume();
    }
  }, [pause, resume, showLogoSlide, playlistState.isPaused]);

  const marqueeEnabled = layerAvailability.marquee && config.showMarquee;

  const isMarqueeVisible = useMemo(() => {
    if (!marqueeEnabled || showLogoSlide || segments.length === 0) {
      return false;
    }

    return true;
  }, [marqueeEnabled, showLogoSlide, segments.length]);

  const stageContainerStyle = embedded
    ? { width: '100%', height: '100%' }
    : { width: '1920px', height: '1080px', transform: 'scale(min(1, min(100vw / 1920, 100vh / 1080)))', transformOrigin: 'center center' };

  const stageContainerClass = embedded
    ? 'relative bg-black text-white overflow-hidden w-full h-full'
    : 'relative bg-black text-white overflow-hidden shadow-2xl';

  const loadingStage = (
    <div className={stageContainerClass} style={stageContainerStyle}>
      {layerAvailability.content ? <CallsignSlide currentTime={callsignTime} audioRef={audioRef} /> : <div className='absolute inset-0 bg-black' />}
    </div>
  );

  if (!dataLoaded) {
    return embedded ? (
      <div className='w-full h-full bg-black overflow-hidden'>{loadingStage}</div>
    ) : (
      <div className='min-h-screen bg-black flex items-center justify-center overflow-hidden'>{loadingStage}</div>
    );
  }

  const liveStage = (
    <div className={stageContainerClass} style={stageContainerStyle}>
      {layerAvailability.content ? (
        showLogoSlide ? (
          <CallsignSlide currentTime={callsignTime} audioRef={audioRef} />
        ) : currentSegment ? (
          currentSegment.render(playlistState.currentItemIndex, playlistState.progress)
        ) : (
          <div className='absolute inset-0 bg-black' />
        )
      ) : (
        <div className='absolute inset-0 bg-black' />
      )}

      {isMarqueeVisible && (
        <div className='absolute bottom-0 left-0 right-0 z-100 transition-transform duration-1000 ease-in-out translate-y-0'>
          {!showLogoSlide &&
            (showCurtain ? (
              <MarqueeCurtain onComplete={handleCurtainComplete} />
            ) : (
              <Marquee
                events={programEvents}
                onCycleComplete={handleMarqueeCycleComplete}
                minPostsCount={config.marqueeMinPostsCount}
                minAverageRelevance={config.marqueeMinAverageRelevance}
                minMedianRelevance={config.marqueeMinMedianRelevance}
                pixelsPerSecond={config.marqueePixelsPerSecond}
                minDurationSeconds={config.marqueeMinDurationSeconds}
                heightPx={config.marqueeHeightPx}
              />
            ))}
        </div>
      )}
    </div>
  );

  return (
    <div className={embedded ? 'w-full h-full bg-black overflow-hidden' : 'min-h-screen bg-black flex items-center justify-center overflow-hidden'}>
      {liveStage}
      <audio ref={audioRef} preload='auto'>
        <source src={FIFTHBELL_ASSETS.audio.pipes} type='audio/ogg' />
      </audio>

      <style>{slideStyles}</style>
    </div>
  );
}
