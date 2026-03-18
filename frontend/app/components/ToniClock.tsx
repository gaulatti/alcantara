import React, { useState, useEffect, useRef } from 'react';
import './ToniClock.css';
import type { GlobalTimeOverride } from '../utils/broadcastTime';
import { getOverrideClockParts } from '../utils/broadcastTime';

export interface ToniClockCity {
  timezone: string;
  label: string;
}

interface ToniClockProps {
  timeOverride?: GlobalTimeOverride | null;
  showSeconds?: boolean;
  cities?: ToniClockCity[];
  rotationIntervalMs?: number;
}

export const DEFAULT_TONI_CLOCK_CITIES: ToniClockCity[] = [
  { timezone: 'Europe/Rome', label: 'Sanremo' },
  { timezone: 'America/New_York', label: 'New York' },
  { timezone: 'Europe/Madrid', label: 'Madrid' },
  { timezone: 'America/Montevideo', label: 'Montevideo' },
  { timezone: 'America/Santiago', label: 'Santiago' }
];

const DEFAULT_CITY_INTERVAL_MS = 5000;

function getTimeForZone(timezone: string, timeOverride: import('../utils/broadcastTime').GlobalTimeOverride | null): string {
  const now = new Date();
  if (timeOverride) {
    const parts = getOverrideClockParts(timeOverride, now);
    if (parts) {
      return `${String(parts.hours).padStart(2, '0')}:${String(parts.minutes).padStart(2, '0')}`;
    }
  }
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      timeZone: timezone
    });
    const p = Object.fromEntries(fmt.formatToParts(now).map((x) => [x.type, x.value]));
    return `${p.hour ?? '00'}:${p.minute ?? '00'}`;
  } catch {
    return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  }
}

export const ToniClock: React.FC<ToniClockProps> = ({
  timeOverride = null,
  showSeconds = false,
  cities = DEFAULT_TONI_CLOCK_CITIES,
  rotationIntervalMs = DEFAULT_CITY_INTERVAL_MS
}) => {
  const resolvedCities = cities.length > 0 ? cities : DEFAULT_TONI_CLOCK_CITIES;
  const [times, setTimes] = useState(() => resolvedCities.map((c) => getTimeForZone(c.timezone, null)));
  const [cityIndex, setCityIndex] = useState(0);
  const cityIndexRef = useRef(0);

  useEffect(() => {
    setTimes(resolvedCities.map((city) => getTimeForZone(city.timezone, timeOverride)));
    cityIndexRef.current = 0;
    setCityIndex(0);
  }, [resolvedCities, timeOverride]);

  // Tick all timezones every second
  useEffect(() => {
    const id = setInterval(() => {
      setTimes(resolvedCities.map((city) => getTimeForZone(city.timezone, timeOverride)));
    }, 1000);
    return () => clearInterval(id);
  }, [resolvedCities, timeOverride, showSeconds]);

  // City cycling
  useEffect(() => {
    if (resolvedCities.length <= 1) {
      return;
    }

    const timer = setInterval(() => {
      const next = (cityIndexRef.current + 1) % resolvedCities.length;
      cityIndexRef.current = next;
      setCityIndex(next);
    }, rotationIntervalMs);
    return () => clearInterval(timer);
  }, [resolvedCities, rotationIntervalMs]);

  return (
    <div className='toni-clock'>
      <div className='toni-clock-time-stack'>
        {resolvedCities.map((city, i) => (
          <div key={city.timezone} className={`toni-clock-time${i === cityIndex ? ' toni-clock-slot--active' : ''}`}>
            {times[i]}
          </div>
        ))}
      </div>
      <div className='toni-clock-label-stack'>
        {resolvedCities.map((city, i) => (
          <div key={city.timezone} className={`toni-clock-label${i === cityIndex ? ' toni-clock-slot--active' : ''}`}>
            {city.label.toUpperCase()}
          </div>
        ))}
      </div>
    </div>
  );
};
