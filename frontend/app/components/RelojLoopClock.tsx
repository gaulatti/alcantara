import { useEffect, useMemo, useState } from 'react';
import './RelojLoopClock.css';

interface RelojLoopClockProps {
  timezone?: string;
}

interface LoopTimezone {
  label: string;
  timezone: string;
}

const LOOP_SECONDS = 30;

const LOOP_TIMEZONES: LoopTimezone[] = [
  { label: 'Madrid', timezone: 'Europe/Madrid' },
  { label: 'Sanremo', timezone: 'Europe/Rome' },
  { label: 'New York', timezone: 'America/New_York' },
  { label: 'Santiago', timezone: 'America/Santiago' }
];

function formatClockTime(now: Date, timezone: string): string {
  try {
    return now.toLocaleTimeString('es-ES', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    });
  } catch {
    return now.toLocaleTimeString('es-ES', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    });
  }
}

export default function RelojLoopClock({ timezone = 'Europe/Madrid' }: RelojLoopClockProps) {
  const defaultIndex = useMemo(() => {
    const idx = LOOP_TIMEZONES.findIndex((item) => item.timezone === timezone);
    return idx >= 0 ? idx : 0;
  }, [timezone]);

  const [activeIndex, setActiveIndex] = useState<number>(defaultIndex);
  const [timeText, setTimeText] = useState<string>(() => formatClockTime(new Date(), LOOP_TIMEZONES[defaultIndex].timezone));

  useEffect(() => {
    setActiveIndex(defaultIndex);
  }, [defaultIndex]);

  useEffect(() => {
    const switchInterval = window.setInterval(() => {
      setActiveIndex((prev) => (prev + 1) % LOOP_TIMEZONES.length);
    }, LOOP_SECONDS * 1000);

    return () => {
      window.clearInterval(switchInterval);
    };
  }, []);

  useEffect(() => {
    const updateTime = () => {
      setTimeText(formatClockTime(new Date(), LOOP_TIMEZONES[activeIndex].timezone));
    };

    updateTime();
    const tickInterval = window.setInterval(updateTime, 1000);

    return () => {
      window.clearInterval(tickInterval);
    };
  }, [activeIndex]);

  const active = LOOP_TIMEZONES[activeIndex];

  return (
    <div className='reloj-loop-root'>
      <div className='reloj-loop-card'>
        <p className='reloj-loop-current-city'>{active.label}</p>
        <p className='reloj-loop-current-time'>{timeText}</p>
        <div className='reloj-loop-sequence'>
          {LOOP_TIMEZONES.map((zone, idx) => (
            <div key={zone.timezone} className={`reloj-loop-sequence-item ${idx === activeIndex ? 'active' : ''}`}>
              {zone.label}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
