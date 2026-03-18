import { BellRing } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FIFTHBELL_ASSETS } from './assets';
import { MarqueeCurtain } from './components/MarqueeCurtain';
import Marquee from './components/Marquee';
import { WorldClocks } from './components/WorldClocks';
import { CallsignSlide } from './components/slides/CallsignSlide';
import { slideStyles } from './components/slides/slideStyles';
import { fetchEvents, getCachedEvents, hasEventChanges, type Event } from './events';
import { getNextLanguageIndex, LANGUAGE_ROTATION, type SupportedLanguage } from './i18n';
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

export default function FifthBellProgram() {
  const [showLogoSlide, setShowLogoSlide] = useState(false);
  const currentTimeRef = useRef(new Date());
  const [callsignTime, setCallsignTime] = useState(new Date());
  const audioRef = useRef<HTMLAudioElement>(null);
  const audioInitialized = useRef(false);

  const [languageIndex, setLanguageIndex] = useState(0);
  const currentLanguage: SupportedLanguage = LANGUAGE_ROTATION[languageIndex];

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

  useEffect(() => {
    updatePendingRef.current = updatePending;
  }, [updatePending]);

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

  useEffect(() => {
    if (dataLoaded) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      window.location.reload();
    }, 15000);

    return () => window.clearTimeout(timeoutId);
  }, [dataLoaded]);

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
    setLanguageIndex((prev) => getNextLanguageIndex(prev));
  }, []);

  const articlesSegment = useMemo(() => {
    const segment = createArticlesSegment(articles, setArticles, currentLanguage);
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
  }, [articles, currentLanguage, refreshEvents]);

  const weatherSegment = useMemo(() => createWeatherSegment(weatherData, setWeatherData, currentLanguage), [currentLanguage, weatherData]);
  const earthquakeSegment = useMemo(() => createEarthquakeSegment(earthquakes, setEarthquakes, currentLanguage), [currentLanguage, earthquakes]);
  const marketsSegment = useMemo(() => createMarketsSegment(markets, setMarkets, currentLanguage), [currentLanguage, markets]);

  const segments = useMemo(
    () => [articlesSegment, weatherSegment, earthquakeSegment, marketsSegment],
    [articlesSegment, earthquakeSegment, marketsSegment, weatherSegment]
  );

  const { state, currentSegment, pause, resume, reset } = usePlaylistEngine({
    segments,
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
    const interval = window.setInterval(() => {
      const now = new Date();
      if (now.getMinutes() === 59 && now.getSeconds() === 55 && audioRef.current) {
        audioRef.current.currentTime = 0;
        void audioRef.current.play().catch((error) => {
          console.log('Audio playback prevented:', error);
        });
      }
    }, 1000);

    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    const checkTime = () => {
      const now = new Date();
      currentTimeRef.current = now;
      const minutes = now.getMinutes();
      const seconds = now.getSeconds();

      const nycTime = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
      const launchDate = new Date('2026-01-02T21:30:00');
      const launchDateNyc = new Date(launchDate.toLocaleString('en-US', { timeZone: 'America/New_York' }));
      const isBeforeLaunch = nycTime < launchDateNyc;

      const shouldShow = isBeforeLaunch ? true : (minutes === 59 && seconds >= 50) || (minutes === 0 && seconds <= 3);
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
  }, [reset, showLogoSlide]);

  useEffect(() => {
    if (showLogoSlide) {
      pause();
    } else if (state.isPaused) {
      resume();
    }
  }, [pause, resume, showLogoSlide, state.isPaused]);

  const isMarqueeVisible = false;

  if (!dataLoaded || !currentSegment) {
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
        {!showLogoSlide && (
          <div className='absolute top-16 right-24 z-50 flex items-start gap-6'>
            <div className='flex items-start pt-1.5'>
              <WorldClocks currentTime={currentTimeRef.current} language={currentLanguage} />
            </div>
            <div className='bg-[#b21100] text-white p-6 shadow-lg'>
              <BellRing size={64} strokeWidth={2} />
            </div>
          </div>
        )}

        {showLogoSlide
          ? currentSegment && <CallsignSlide currentTime={callsignTime} audioRef={audioRef} />
          : currentSegment.render(state.currentItemIndex, state.progress)}

        <div
          className={`absolute bottom-0 left-0 right-0 z-100 transition-transform duration-1000 ease-in-out ${isMarqueeVisible ? 'translate-y-0' : 'translate-y-full'}`}
        >
          {!showLogoSlide &&
            (showCurtain ? (
              <MarqueeCurtain onComplete={handleCurtainComplete} />
            ) : (
              <Marquee events={programEvents} onCycleComplete={handleMarqueeCycleComplete} />
            ))}
        </div>
      </div>

      <audio ref={audioRef} preload='auto'>
        <source src={FIFTHBELL_ASSETS.audio.pipes} type='audio/ogg' />
      </audio>

      <style>{slideStyles}</style>
    </div>
  );
}
