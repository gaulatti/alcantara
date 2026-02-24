import { useEffect, useMemo, useRef, useState } from 'react';
import './RelojLoopClock.css';

interface RelojLoopClockProps {
  timezone?: string;
}

interface LoopTimezone {
  label: string;
  timezone: string;
}

const LOOP_TIMEZONES: LoopTimezone[] = [
  { label: 'Madrid', timezone: 'Europe/Madrid' },
  { label: 'Sanremo', timezone: 'Europe/Rome' },
  { label: 'New York', timezone: 'America/New_York' },
  { label: 'Santiago', timezone: 'America/Santiago' }
];

interface HandAngles {
  hours: number;
  minutes: number;
  seconds: number;
}

function getHandAngles(now: Date, timezone: string): HandAngles {
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      timeZone: timezone
    });
    const p = Object.fromEntries(fmt.formatToParts(now).map((x) => [x.type, x.value]));
    const h = Number(p.hour ?? 0) % 12;
    const m = Number(p.minute ?? 0);
    const s = Number(p.second ?? 0);
    return {
      seconds: s * 6,
      minutes: m * 6 + s * 0.1,
      hours: h * 30 + m * 0.5
    };
  } catch {
    const h = now.getHours() % 12;
    const m = now.getMinutes();
    const s = now.getSeconds();
    return { seconds: s * 6, minutes: m * 6 + s * 0.1, hours: h * 30 + m * 0.5 };
  }
}

export default function RelojLoopClock({ timezone = 'Europe/Madrid' }: RelojLoopClockProps) {
  const defaultIndex = useMemo(() => {
    const idx = LOOP_TIMEZONES.findIndex((item) => item.timezone === timezone);
    return idx >= 0 ? idx : 0;
  }, [timezone]);

  const [activeIndex, setActiveIndex] = useState<number>(defaultIndex);
  const [angles, setAngles] = useState<HandAngles>(() => getHandAngles(new Date(), LOOP_TIMEZONES[defaultIndex].timezone));
  const [transitioning, setTransitioning] = useState(false);

  useEffect(() => {
    setActiveIndex(defaultIndex);
  }, [defaultIndex]);

  const activeIndexRef = useRef(defaultIndex);

  useEffect(() => {
    // Switch at the top of every minute (seconds === 0)
    const id = window.setInterval(() => {
      const now = new Date();
      const secs = now.getSeconds();
      if (secs === 0) {
        setTransitioning(true);
        setTimeout(() => {
          const next = (activeIndexRef.current + 1) % LOOP_TIMEZONES.length;
          activeIndexRef.current = next;
          setActiveIndex(next);
          setTransitioning(false);
        }, 500);
      }
    }, 1000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    const tick = () => setAngles(getHandAngles(new Date(), LOOP_TIMEZONES[activeIndex].timezone));
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [activeIndex]);

  const active = LOOP_TIMEZONES[activeIndex];
  const R = 200; // SVG clock radius

  // Hour markers
  const markers = Array.from({ length: 12 }, (_, i) => {
    const angle = (i * 30 * Math.PI) / 180;
    const isMajor = i % 3 === 0;
    const inner = isMajor ? R * 0.78 : R * 0.85;
    const outer = R * 0.95;
    return {
      x1: Math.sin(angle) * inner,
      y1: -Math.cos(angle) * inner,
      x2: Math.sin(angle) * outer,
      y2: -Math.cos(angle) * outer,
      isMajor
    };
  });

  return (
    <div className='reloj-loop-root'>
      <div className='reloj-loop-card'>
        <svg
          className={`reloj-loop-analog${transitioning ? ' reloj-loop-analog--out' : ''}`}
          viewBox={`${-R - 20} ${-R - 20} ${(R + 20) * 2} ${(R + 20) * 2}`}
          xmlns='http://www.w3.org/2000/svg'
        >
          {/* Face */}
          <circle cx={0} cy={0} r={R} fill='rgba(10,18,34,0.85)' stroke='rgba(148,173,214,0.35)' strokeWidth={3} />

          {/* Tick marks */}
          {markers.map((m, i) => (
            <line
              key={i}
              x1={m.x1}
              y1={m.y1}
              x2={m.x2}
              y2={m.y2}
              stroke={m.isMajor ? 'rgba(200,215,240,0.9)' : 'rgba(148,173,214,0.45)'}
              strokeWidth={m.isMajor ? 3.5 : 1.5}
              strokeLinecap='round'
            />
          ))}

          {/* Hour hand */}
          <line
            x1={-Math.sin((angles.hours * Math.PI) / 180) * R * 0.12}
            y1={Math.cos((angles.hours * Math.PI) / 180) * R * 0.12}
            x2={Math.sin((angles.hours * Math.PI) / 180) * R * 0.55}
            y2={-Math.cos((angles.hours * Math.PI) / 180) * R * 0.55}
            stroke='#e8edf7'
            strokeWidth={10}
            strokeLinecap='round'
          />

          {/* Minute hand */}
          <line
            x1={-Math.sin((angles.minutes * Math.PI) / 180) * R * 0.14}
            y1={Math.cos((angles.minutes * Math.PI) / 180) * R * 0.14}
            x2={Math.sin((angles.minutes * Math.PI) / 180) * R * 0.78}
            y2={-Math.cos((angles.minutes * Math.PI) / 180) * R * 0.78}
            stroke='#c8d8f0'
            strokeWidth={6}
            strokeLinecap='round'
          />

          {/* Second hand */}
          <line
            x1={-Math.sin((angles.seconds * Math.PI) / 180) * R * 0.2}
            y1={Math.cos((angles.seconds * Math.PI) / 180) * R * 0.2}
            x2={Math.sin((angles.seconds * Math.PI) / 180) * R * 0.88}
            y2={-Math.cos((angles.seconds * Math.PI) / 180) * R * 0.88}
            stroke='#ff4422'
            strokeWidth={2.5}
            strokeLinecap='round'
          />

          {/* Center cap */}
          <circle cx={0} cy={0} r={8} fill='#e8edf7' />
          <circle cx={0} cy={0} r={4} fill='#ff4422' />
        </svg>
        <p className={`reloj-loop-city-label${transitioning ? ' reloj-loop-city-label--out' : ''}`}>{active.label.toUpperCase()}</p>
      </div>
    </div>
  );
}
