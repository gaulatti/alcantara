import React from 'react';
import { BellRing } from 'lucide-react';
import './ToniClock.css';
import type { GlobalTimeOverride } from '../utils/broadcastTime';
import { WorldClocks } from '../programs/fifthbell/components/WorldClocks';
import type { SupportedLanguage } from '../programs/fifthbell/i18n';

export interface ToniClockCity {
  city: string;
  timezone: string;
}

interface ToniClockProps {
  timeOverride?: GlobalTimeOverride | null;
  cities?: ToniClockCity[];
  rotationIntervalMs?: number;
  transitionDurationMs?: number;
  shuffleCities?: boolean;
  widthPx?: number;
  language?: SupportedLanguage;
  showWorldClocks?: boolean;
  showBellIcon?: boolean;
  bellLogoUrl?: string;
  bellSize?: number;
  inline?: boolean;
}

export const DEFAULT_TONI_CLOCK_CITIES: ToniClockCity[] = [
  { city: 'SANREMO', timezone: 'Europe/Rome' },
  { city: 'NEW YORK', timezone: 'America/New_York' },
  { city: 'MADRID', timezone: 'Europe/Madrid' },
  { city: 'MONTEVIDEO', timezone: 'America/Montevideo' },
  { city: 'SANTIAGO', timezone: 'America/Santiago' }
];

const DEFAULT_CITY_INTERVAL_MS = 5000;

export const ToniClock: React.FC<ToniClockProps> = ({
  timeOverride = null,
  cities = DEFAULT_TONI_CLOCK_CITIES,
  rotationIntervalMs = DEFAULT_CITY_INTERVAL_MS,
  transitionDurationMs = 300,
  shuffleCities = false,
  widthPx = 200,
  language = 'en',
  showWorldClocks = true,
  showBellIcon = false,
  bellLogoUrl,
  bellSize = 64,
  inline = false
}) => {
  const resolvedCities = cities.length > 0 ? cities : DEFAULT_TONI_CLOCK_CITIES;
  if (!showWorldClocks && !showBellIcon) {
    return null;
  }

  return (
    <div className={`toni-clock-corner${inline ? ' toni-clock-corner--inline' : ''}`}>
      {showWorldClocks && (
        <div className='flex items-start pt-1.5'>
          <WorldClocks
            timeOverride={timeOverride}
            language={language}
            cities={resolvedCities}
            rotateIntervalMs={rotationIntervalMs}
            transitionDurationMs={transitionDurationMs}
            shuffleCities={shuffleCities}
            widthPx={widthPx}
          />
        </div>
      )}
      {showBellIcon && (
        <div className='toni-clock-bell'>
          {bellLogoUrl ? (
            <img
              src={bellLogoUrl}
              alt='FifthBell logo'
              className='toni-clock-bell-logo'
              style={{ width: `${bellSize}px`, height: `${bellSize}px` }}
            />
          ) : (
            <BellRing size={bellSize} strokeWidth={2} />
          )}
        </div>
      )}
    </div>
  );
};
