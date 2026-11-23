import { useCallback } from 'react';
import { ClockWidget as BleeckerClockWidget } from '../bleecker';
import type { GlobalTimeOverride } from '../utils/broadcastTime';
import { formatClockParts, getOverrideClockParts } from '../utils/broadcastTime';

interface ClockWidgetProps {
  showIcon?: boolean;
  iconUrl?: string;
  timezone?: string;
  timeOverride?: GlobalTimeOverride | null;
}

/** The broadcast face artwork for the clock, supplied to the Bleecker widget. */
const CLOCK_BACKGROUND_URL = '/reloj.png';

function localTime(now: Date, timezone: string): string {
  try {
    return now.toLocaleTimeString('es-AR', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hour12: false });
  } catch {
    console.error('Invalid timezone:', timezone);
    return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  }
}

/** The on-air clock: the broadcast time override when one is set, else the local time in the given zone. */
export function ClockWidget({
  showIcon = true,
  iconUrl,
  timezone = 'America/Argentina/Buenos_Aires',
  timeOverride = null,
}: ClockWidgetProps) {
  const formatTime = useCallback(
    (now: Date) => {
      if (timeOverride) {
        const overrideParts = getOverrideClockParts(timeOverride, now);
        if (overrideParts) return formatClockParts(overrideParts);
      }
      return localTime(now, timezone);
    },
    [timeOverride, timezone],
  );

  return (
    <BleeckerClockWidget
      showIcon={showIcon}
      iconUrl={iconUrl}
      formatTime={formatTime}
      backgroundUrl={CLOCK_BACKGROUND_URL}
    />
  );
}
