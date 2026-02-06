import React, { useState, useEffect } from 'react';
import './ClockWidget.css';

interface ClockWidgetProps {
  showIcon?: boolean;
  iconUrl?: string;
  timezone?: string;
}

export const ClockWidget: React.FC<ClockWidgetProps> = ({ showIcon = true, iconUrl, timezone = 'America/Argentina/Buenos_Aires' }) => {
  const [time, setTime] = useState('');

  useEffect(() => {
    const updateTime = () => {
      const now = new Date();
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
  }, [timezone]);

  return (
    <div className='clock-widget'>
      <div className='clock-time'>{time}</div>
      {showIcon && <div className='clock-icon'>{iconUrl ? <img src={iconUrl} alt='icon' /> : <div className='default-icon'>🌴</div>}</div>}
    </div>
  );
};
