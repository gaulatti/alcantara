import { useEffect, useState } from 'react';
import { t, type SupportedLanguage } from '../i18n';
import type { GlobalTimeOverride } from '../../../utils/broadcastTime';
import { getOverrideClockParts } from '../../../utils/broadcastTime';

interface CityTime {
  city: string;
  timezone: string;
}

export const DEFAULT_WORLD_CLOCK_CITIES: CityTime[] = [
  { city: 'NEW YORK', timezone: 'America/New_York' },
  { city: 'LONDON', timezone: 'Europe/London' },
  { city: 'TOKYO', timezone: 'Asia/Tokyo' },
  { city: 'SYDNEY', timezone: 'Australia/Sydney' },
  { city: 'ROME', timezone: 'Europe/Rome' },
  { city: 'MADRID', timezone: 'Europe/Madrid' },
  { city: 'LIMA', timezone: 'America/Lima' },
  { city: 'BERLIN', timezone: 'Europe/Berlin' },
  { city: 'LOS ANGELES', timezone: 'America/Los_Angeles' },
  { city: 'MEXICO CITY', timezone: 'America/Mexico_City' },
  { city: 'SANTIAGO', timezone: 'America/Santiago' },
  { city: 'BUENOS AIRES', timezone: 'America/Argentina/Buenos_Aires' },
  { city: 'SÃO PAULO', timezone: 'America/Sao_Paulo' },
  { city: 'HONOLULU', timezone: 'Pacific/Honolulu' },
  { city: 'BEIJING', timezone: 'Asia/Shanghai' },
  { city: 'SINGAPORE', timezone: 'Asia/Singapore' },
  { city: 'DELHI', timezone: 'Asia/Kolkata' },
  { city: 'LAHORE', timezone: 'Asia/Karachi' },
  { city: 'MOSCOW', timezone: 'Europe/Moscow' },
  { city: 'KYIV', timezone: 'Europe/Kiev' },
  { city: 'CAIRO', timezone: 'Africa/Cairo' },
  { city: 'LAGOS', timezone: 'Africa/Lagos' },
  { city: 'CAPE TOWN', timezone: 'Africa/Johannesburg' },
  { city: 'NAIROBI', timezone: 'Africa/Nairobi' },
  { city: 'CASABLANCA', timezone: 'Africa/Casablanca' }
];
const TRANSLATABLE_CITY_KEYS = new Set(DEFAULT_WORLD_CLOCK_CITIES.map((city) => city.city));

function shuffleArray<T>(array: T[]): T[] {
  const shuffled = [...array];
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

interface WorldClocksProps {
  currentTime?: Date;
  timeOverride?: GlobalTimeOverride | null;
  language?: SupportedLanguage;
  cities?: CityTime[];
  rotateIntervalMs?: number;
  transitionDurationMs?: number;
  shuffleCities?: boolean;
  widthPx?: number;
}

export function WorldClocks({
  currentTime,
  timeOverride = null,
  language = 'en',
  cities,
  rotateIntervalMs = 7000,
  transitionDurationMs = 300,
  shuffleCities = true,
  widthPx = 200
}: WorldClocksProps) {
  const activeCities = cities && cities.length > 0 ? cities : DEFAULT_WORLD_CLOCK_CITIES;
  const [time, setTime] = useState(currentTime || new Date());
  const [cityPool, setCityPool] = useState<CityTime[]>(() => (shuffleCities ? shuffleArray(activeCities) : [...activeCities]));
  const [currentCityIndex, setCurrentCityIndex] = useState(0);
  const [isAnimating, setIsAnimating] = useState(false);

  useEffect(() => {
    setCityPool(shuffleCities ? shuffleArray(activeCities) : [...activeCities]);
    setCurrentCityIndex(0);
  }, [activeCities, shuffleCities]);

  useEffect(() => {
    if (currentTime) {
      setTime(currentTime);
      return;
    }

    const interval = setInterval(() => {
      setTime(new Date());
    }, 1000);

    return () => clearInterval(interval);
  }, [currentTime]);

  useEffect(() => {
    let timeoutId: number | undefined;

    const interval = setInterval(() => {
      setIsAnimating(true);
      timeoutId = window.setTimeout(() => {
        setCurrentCityIndex((prevIndex) => {
          const nextIndex = prevIndex + 1;
          if (nextIndex >= cityPool.length) {
            setCityPool(shuffleCities ? shuffleArray(activeCities) : [...activeCities]);
            return 0;
          }
          return nextIndex;
        });
        setIsAnimating(false);
      }, Math.max(0, transitionDurationMs));
    }, Math.max(500, rotateIntervalMs));

    return () => {
      clearInterval(interval);
      if (timeoutId !== undefined) {
        window.clearTimeout(timeoutId);
      }
    };
  }, [cityPool, rotateIntervalMs, transitionDurationMs, shuffleCities, activeCities]);

  const currentCity = cityPool[currentCityIndex] ?? activeCities[0];
  const formatTime = (timezone: string) => {
    if (timeOverride) {
      const parts = getOverrideClockParts(timeOverride, time);
      if (parts) {
        return `${String(parts.hours).padStart(2, '0')}:${String(parts.minutes).padStart(2, '0')}`;
      }
    }

    return time.toLocaleTimeString('en-US', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    });
  };
  const cityLabel = TRANSLATABLE_CITY_KEYS.has(currentCity.city) ? t(`city.${currentCity.city}`, language) : currentCity.city;

  return (
    <div className='flex flex-col gap-1.5 transition-opacity duration-300' style={{ opacity: isAnimating ? 0 : 1, width: `${widthPx}px` }}>
      <div className='text-white font-bold text-6xl tracking-tight leading-none text-center' style={{ fontFamily: 'system-ui, -apple-system, sans-serif' }}>
        {formatTime(currentCity.timezone)}
      </div>
      <div className='text-white/50 text-2xl font-bold tracking-wider leading-none uppercase text-center' style={{ fontFamily: 'system-ui, -apple-system, sans-serif' }}>
        {cityLabel}
      </div>
    </div>
  );
}
