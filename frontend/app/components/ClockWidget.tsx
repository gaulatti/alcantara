import React, { useState, useEffect } from 'react';
import './ClockWidget.css';
import type { GlobalTimeOverride } from '../utils/broadcastTime';
import { formatClockParts, getOverrideClockParts } from '../utils/broadcastTime';

interface ClockWidgetProps {
  showIcon?: boolean;
  iconUrl?: string;
  timezone?: string;
  timeOverride?: GlobalTimeOverride | null;
}

export const ClockWidget: React.FC<ClockWidgetProps> = ({
  showIcon = true,
  iconUrl,
  timezone = 'America/Argentina/Buenos_Aires',
  timeOverride = null,
}) => {
  const [time, setTime] = useState('');

  useEffect(() => {
    const updateTime = () => {
      const now = new Date();

      if (timeOverride) {
        const overrideParts = getOverrideClockParts(timeOverride, now);
        if (overrideParts) {
          setTime(formatClockParts(overrideParts));
          return;
        }
      }

      try {
        const timeString = now.toLocaleTimeString('es-AR', {
          timeZone: timezone,
          hour: '2-digit',
          minute: '2-digit',
          hour12: false
        });
        setTime(timeString);
      } catch (err) {
        console.error('Invalid timezone:', timezone);
        // Fallback to default format
        const hours = String(now.getHours()).padStart(2, '0');
        const minutes = String(now.getMinutes()).padStart(2, '0');
        setTime(`${hours}:${minutes}`);
      }
    };

    updateTime();
    const interval = setInterval(updateTime, 1000);

    return () => clearInterval(interval);
  }, [timezone, timeOverride?.startTime, timeOverride?.startedAt]);

  return (
    <div className='clock-widget'>
      <div className='clock-time'>{time}</div>
      {showIcon && <div className='clock-icon'>{iconUrl ? <img src={iconUrl} alt='icon' /> : null}</div>}
    </div>
  );
};
