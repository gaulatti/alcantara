import { useEffect, useState } from 'react';
import { t, type SupportedLanguage } from '../i18n';

interface CityTime {
  city: string;
  timezone: string;
}

const CITIES: CityTime[] = [
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
  language?: SupportedLanguage;
}

export function WorldClocks({ currentTime, language = 'en' }: WorldClocksProps) {
  const [time, setTime] = useState(currentTime || new Date());
  const [cityPool, setCityPool] = useState<CityTime[]>(() => shuffleArray(CITIES));
  const [currentCityIndex, setCurrentCityIndex] = useState(0);
  const [isAnimating, setIsAnimating] = useState(false);

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
            setCityPool(shuffleArray(CITIES));
            return 0;
          }
          return nextIndex;
        });
        setIsAnimating(false);
      }, 300);
    }, 7000);

    return () => {
      clearInterval(interval);
      if (timeoutId !== undefined) {
        window.clearTimeout(timeoutId);
      }
    };
  }, [cityPool]);

  const currentCity = cityPool[currentCityIndex];
  const formatTime = (timezone: string) =>
    time.toLocaleTimeString('en-US', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    });

  return (
    <div className='flex flex-col gap-1.5 transition-opacity duration-300' style={{ opacity: isAnimating ? 0 : 1, width: '200px' }}>
      <div className='text-white font-bold text-6xl tracking-tight leading-none text-center' style={{ fontFamily: 'system-ui, -apple-system, sans-serif' }}>
        {formatTime(currentCity.timezone)}
      </div>
      <div className='text-white/50 text-2xl font-bold tracking-wider leading-none uppercase text-center' style={{ fontFamily: 'system-ui, -apple-system, sans-serif' }}>
        {t(`city.${currentCity.city}`, language)}
      </div>
    </div>
  );
}
