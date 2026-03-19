import React from 'react';
import { ToniClock } from './ToniClock';
import type { SupportedLanguage } from '../programs/fifthbell/i18n';
import type { ToniClockCity } from './ToniClock';
import type { GlobalTimeOverride } from '../utils/broadcastTime';

interface ModoItalianoClockProps {
  timeOverride?: GlobalTimeOverride | null;
  cities?: ToniClockCity[];
  rotationIntervalMs?: number;
  transitionDurationMs?: number;
  shuffleCities?: boolean;
  widthPx?: number;
  language?: SupportedLanguage;
  showWorldClocks?: boolean;
  showBellIcon?: boolean;
}

const DEFAULT_MODOITALIANO_CLOCK_CITIES: ToniClockCity[] = [
  { city: 'SANREMO', timezone: 'Europe/Rome' },
  { city: 'ROME', timezone: 'Europe/Rome' },
  { city: 'MILAN', timezone: 'Europe/Rome' },
  { city: 'MADRID', timezone: 'Europe/Madrid' },
  { city: 'NEW YORK', timezone: 'America/New_York' }
];

export const ModoItalianoClock: React.FC<ModoItalianoClockProps> = ({
  timeOverride = null,
  cities = DEFAULT_MODOITALIANO_CLOCK_CITIES,
  rotationIntervalMs = 5000,
  transitionDurationMs = 300,
  shuffleCities = false,
  widthPx = 220,
  language = 'it',
  showWorldClocks = true,
  showBellIcon = false
}) => {
  return (
    <ToniClock
      timeOverride={timeOverride}
      cities={cities}
      rotationIntervalMs={rotationIntervalMs}
      transitionDurationMs={transitionDurationMs}
      shuffleCities={shuffleCities}
      widthPx={widthPx}
      language={language}
      showWorldClocks={showWorldClocks}
      showBellIcon={showBellIcon}
    />
  );
};
