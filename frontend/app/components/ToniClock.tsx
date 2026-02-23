import React, { useState, useEffect } from 'react';
import './ToniClock.css';
import type { GlobalTimeOverride } from '../utils/broadcastTime';
import { getOverrideClockParts } from '../utils/broadcastTime';

interface ToniClockProps {
  timezone?: string;
  timeOverride?: GlobalTimeOverride | null;
  showSeconds?: boolean;
  label?: string;
}

export const ToniClock: React.FC<ToniClockProps> = ({
  timezone = 'America/Argentina/Buenos_Aires',
  timeOverride = null,
  showSeconds = true,
  label,
}) => {
  const [time, setTime] = useState('');

  useEffect(() => {
    const getTimeParts = (date: Date): { hours: number; minutes: number; seconds: number } => {
      if (timeOverride) {
        const parts = getOverrideClockParts(timeOverride, date);
        if (parts) return parts;
      }
      try {
        const fmt = new Intl.DateTimeFormat('en-US', {
          hour12: false,
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
          timeZone: timezone,
        });
        const p = Object.fromEntries(fmt.formatToParts(date).map((x) => [x.type, x.value]));
        return {
          hours: Number(p.hour ?? date.getHours()),
          minutes: Number(p.minute ?? date.getMinutes()),
          seconds: Number(p.second ?? date.getSeconds()),
        };
      } catch {
        return { hours: date.getHours(), minutes: date.getMinutes(), seconds: date.getSeconds() };
      }
    };

    const update = () => {
      const { hours, minutes, seconds } = getTimeParts(new Date());
      const h = String(hours).padStart(2, '0');
      const m = String(minutes).padStart(2, '0');
      const s = String(seconds).padStart(2, '0');
      setTime(showSeconds ? `${h}:${m}:${s}` : `${h}:${m}`);
    };

    update();
    const id = setInterval(update, 1000);
    return () => clearInterval(id);
  }, [timezone, showSeconds, timeOverride?.startTime, timeOverride?.startedAt]);

  return (
    <div className='toni-clock'>
      <div className='toni-clock-time'>{time}</div>
      {label && <div className='toni-clock-label'>{label}</div>}
    </div>
  );
};
