import { BellRing } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSSE } from '../../hooks/useSSE';
import { apiUrl } from '../../utils/apiBaseUrl';
import { FIFTHBELL_ASSETS } from './assets';
import { MarqueeCurtain } from './components/MarqueeCurtain';
import Marquee from './components/Marquee';
import { DEFAULT_WORLD_CLOCK_CITIES, WorldClocks } from './components/WorldClocks';
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

function extractConfigFromSceneMetadata(scene: Scene | null): FifthBellConfig {
  if (!scene || !scene.metadata) {
    return DEFAULT_FIFTHBELL_CONFIG;
  }

  try {
    const metadata = JSON.parse(scene.metadata);
    const fifthbellProps = metadata?.fifthbell;
    if (!fifthbellProps || typeof fifthbellProps !== 'object' || Array.isArray(fifthbellProps)) {
      return DEFAULT_FIFTHBELL_CONFIG;
    }

    const parsedMarqueeMinPostsCount = clampNumber(fifthbellProps.marqueeMinPostsCount, DEFAULT_FIFTHBELL_CONFIG.marqueeMinPostsCount, 0, 50);
    let parsedMarqueeMinAverageRelevance = clampNumber(fifthbellProps.marqueeMinAverageRelevance, DEFAULT_FIFTHBELL_CONFIG.marqueeMinAverageRelevance, 0, 100);
    let parsedMarqueeMinMedianRelevance = clampNumber(fifthbellProps.marqueeMinMedianRelevance, DEFAULT_FIFTHBELL_CONFIG.marqueeMinMedianRelevance, 0, 100);

    // Compatibility: prior defaults were tuned for OR logic. Under threshold logic, treat that trio as legacy.
    if (parsedMarqueeMinPostsCount === 4 && parsedMarqueeMinAverageRelevance === 5 && parsedMarqueeMinMedianRelevance === 7) {
      parsedMarqueeMinAverageRelevance = 0;
      parsedMarqueeMinMedianRelevance = 0;
    }

    return {
      showArticles: normalizeBoolean(fifthbellProps.showArticles, DEFAULT_FIFTHBELL_CONFIG.showArticles),
      showWeather: normalizeBoolean(fifthbellProps.showWeather, DEFAULT_FIFTHBELL_CONFIG.showWeather),
      showEarthquakes: normalizeBoolean(fifthbellProps.showEarthquakes, DEFAULT_FIFTHBELL_CONFIG.showEarthquakes),
      showMarkets: normalizeBoolean(fifthbellProps.showMarkets, DEFAULT_FIFTHBELL_CONFIG.showMarkets),
      showMarquee: normalizeBoolean(fifthbellProps.showMarquee, DEFAULT_FIFTHBELL_CONFIG.showMarquee),
      showCallsignTake: normalizeBoolean(fifthbellProps.showCallsignTake, DEFAULT_FIFTHBELL_CONFIG.showCallsignTake),
      weatherCities: normalizeStringArray(fifthbellProps.weatherCities),
      languageRotation: normalizeLanguageRotation(fifthbellProps.languageRotation),
      dataLoadTimeoutMs: clampNumber(fifthbellProps.dataLoadTimeoutMs, DEFAULT_FIFTHBELL_CONFIG.dataLoadTimeoutMs, 1000, 120000),
      playlistDefaultDurationMs: clampNumber(fifthbellProps.playlistDefaultDurationMs, DEFAULT_FIFTHBELL_CONFIG.playlistDefaultDurationMs, 1000, 120000),
      playlistUpdateIntervalMs: clampNumber(fifthbellProps.playlistUpdateIntervalMs, DEFAULT_FIFTHBELL_CONFIG.playlistUpdateIntervalMs, 16, 5000),
      articlesDurationMs: clampNumber(fifthbellProps.articlesDurationMs, DEFAULT_FIFTHBELL_CONFIG.articlesDurationMs, 1000, 120000),
      weatherDurationMs: clampNumber(fifthbellProps.weatherDurationMs, DEFAULT_FIFTHBELL_CONFIG.weatherDurationMs, 1000, 120000),
      earthquakesDurationMs: clampNumber(fifthbellProps.earthquakesDurationMs, DEFAULT_FIFTHBELL_CONFIG.earthquakesDurationMs, 1000, 120000),
      marketsDurationMs: clampNumber(fifthbellProps.marketsDurationMs, DEFAULT_FIFTHBELL_CONFIG.marketsDurationMs, 1000, 120000),
      showWorldClocks: normalizeBoolean(fifthbellProps.showWorldClocks, DEFAULT_FIFTHBELL_CONFIG.showWorldClocks),
      showBellIcon: normalizeBoolean(fifthbellProps.showBellIcon, DEFAULT_FIFTHBELL_CONFIG.showBellIcon),
      worldClockRotateIntervalMs: clampNumber(fifthbellProps.worldClockRotateIntervalMs, DEFAULT_FIFTHBELL_CONFIG.worldClockRotateIntervalMs, 500, 120000),
      worldClockTransitionMs: clampNumber(fifthbellProps.worldClockTransitionMs, DEFAULT_FIFTHBELL_CONFIG.worldClockTransitionMs, 0, 10000),
      worldClockShuffle: normalizeBoolean(fifthbellProps.worldClockShuffle, DEFAULT_FIFTHBELL_CONFIG.worldClockShuffle),
      worldClockWidthPx: clampNumber(fifthbellProps.worldClockWidthPx, DEFAULT_FIFTHBELL_CONFIG.worldClockWidthPx, 120, 600),
      worldClockCities: normalizeWorldClockCities(fifthbellProps.worldClockCities),
      audioCueEnabled: normalizeBoolean(fifthbellProps.audioCueEnabled, DEFAULT_FIFTHBELL_CONFIG.audioCueEnabled),
      audioCueMinute: clampNumber(fifthbellProps.audioCueMinute, DEFAULT_FIFTHBELL_CONFIG.audioCueMinute, 0, 59),
      audioCueSecond: clampNumber(fifthbellProps.audioCueSecond, DEFAULT_FIFTHBELL_CONFIG.audioCueSecond, 0, 59),
      callsignPrelaunchUntilNyc:
        typeof fifthbellProps.callsignPrelaunchUntilNyc === 'string' && fifthbellProps.callsignPrelaunchUntilNyc.trim()
          ? fifthbellProps.callsignPrelaunchUntilNyc.trim()
          : DEFAULT_FIFTHBELL_CONFIG.callsignPrelaunchUntilNyc,
      callsignWindowStartSecond: clampNumber(fifthbellProps.callsignWindowStartSecond, DEFAULT_FIFTHBELL_CONFIG.callsignWindowStartSecond, 0, 59),
      callsignWindowEndSecond: clampNumber(fifthbellProps.callsignWindowEndSecond, DEFAULT_FIFTHBELL_CONFIG.callsignWindowEndSecond, 0, 59),
      marqueeMinPostsCount: parsedMarqueeMinPostsCount,
      marqueeMinAverageRelevance: parsedMarqueeMinAverageRelevance,
      marqueeMinMedianRelevance: parsedMarqueeMinMedianRelevance,
      marqueePixelsPerSecond: clampNumber(fifthbellProps.marqueePixelsPerSecond, DEFAULT_FIFTHBELL_CONFIG.marqueePixelsPerSecond, 10, 1000),
      marqueeMinDurationSeconds: clampNumber(fifthbellProps.marqueeMinDurationSeconds, DEFAULT_FIFTHBELL_CONFIG.marqueeMinDurationSeconds, 1, 120),
      marqueeHeightPx: clampNumber(fifthbellProps.marqueeHeightPx, DEFAULT_FIFTHBELL_CONFIG.marqueeHeightPx, 72, 200)
    };
  } catch {
    return DEFAULT_FIFTHBELL_CONFIG;
  }
}

function normalizeLaunchDate(rawDate: string): Date {
  const parsed = new Date(rawDate);
  if (Number.isNaN(parsed.getTime())) {
    return new Date(DEFAULT_CALLSIGN_PRELAUNCH_UNTIL_NYC);
  }

  return parsed;
}

export default function FifthBellProgram() {
  const [state, setState] = useState<ProgramState | null>(null);
  const [showLogoSlide, setShowLogoSlide] = useState(false);
  const currentTimeRef = useRef(new Date());
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

  const config = useMemo(() => extractConfigFromSceneMetadata(state?.activeScene ?? null), [state?.activeScene]);
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
    fetch(apiUrl('/program/fifthbell/state'))
      .then((res) => res.json())
      .then((data) => setState(data))
      .catch((err) => console.error('Failed to fetch FifthBell program state:', err));
  }, []);

  const refreshAllData = useCallback(async () => {
    const [articlesData, weatherDataResult, earthquakesData, marketsData] = await Promise.all([
      fetchArticles(currentLanguage),
      fetchWeatherData(),
      fetchEarthquakes(currentLanguage),
      fetchMarketData(),
      fetchEvents()
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
    url: apiUrl('/program/fifthbell/events'),
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
    await fetchEvents();
    const cachedEvents = getCachedEvents();
    if (!cachedEvents) {
      return;
    }

    setStageEvents((prevStage) => {
      const prevJson = JSON.stringify(prevStage);
      const nextJson = JSON.stringify(cachedEvents);
      return prevJson === nextJson ? prevStage : cachedEvents;
    });
  }, []);

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
      currentTimeRef.current = now;
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

  const marqueeEnabled = config.showMarquee;

  const isMarqueeVisible = useMemo(() => {
    if (!marqueeEnabled || showLogoSlide || segments.length === 0) {
      return false;
    }

    return true;
  }, [marqueeEnabled, showLogoSlide, segments.length]);

  if (!dataLoaded) {
    return (
      <div className='min-h-screen bg-black flex items-center justify-center overflow-hidden'>
        <div
          className='relative bg-black text-white overflow-hidden shadow-2xl'
          style={{ width: '1920px', height: '1080px', transform: 'scale(min(1, min(100vw / 1920, 100vh / 1080)))', transformOrigin: 'center center' }}
        >
          <CallsignSlide currentTime={callsignTime} audioRef={audioRef} />
        </div>
      </div>
    );
  }

  return (
    <div className='min-h-screen bg-black flex items-center justify-center overflow-hidden'>
      <div
        className='relative bg-black text-white overflow-hidden shadow-2xl'
        style={{ width: '1920px', height: '1080px', transform: 'scale(min(1, min(100vw / 1920, 100vh / 1080)))', transformOrigin: 'center center' }}
      >
        {!showLogoSlide && (config.showWorldClocks || config.showBellIcon) && (
          <div className='absolute top-16 right-24 z-50 flex items-start gap-6'>
            {config.showWorldClocks && (
              <div className='flex items-start pt-1.5'>
                <WorldClocks
                  currentTime={currentTimeRef.current}
                  language={currentLanguage}
                  cities={config.worldClockCities}
                  rotateIntervalMs={config.worldClockRotateIntervalMs}
                  transitionDurationMs={config.worldClockTransitionMs}
                  shuffleCities={config.worldClockShuffle}
                  widthPx={config.worldClockWidthPx}
                />
              </div>
            )}
            {config.showBellIcon && (
              <div className='bg-[#b21100] text-white p-6 shadow-lg'>
                <BellRing size={64} strokeWidth={2} />
              </div>
            )}
          </div>
        )}

        {showLogoSlide ? (
          <CallsignSlide currentTime={callsignTime} audioRef={audioRef} />
        ) : currentSegment ? (
          currentSegment.render(playlistState.currentItemIndex, playlistState.progress)
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

      <audio ref={audioRef} preload='auto'>
        <source src={FIFTHBELL_ASSETS.audio.pipes} type='audio/ogg' />
      </audio>

      <style>{slideStyles}</style>
    </div>
  );
}
