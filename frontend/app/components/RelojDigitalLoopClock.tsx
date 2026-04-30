import { useEffect, useMemo, useRef, useState } from 'react';
import './RelojDigitalLoopClock.css';

interface RelojDigitalLoopClockProps {
  timezone?: string;
  title?: string;
}

interface LoopTimezone {
  label: string;
  timezone: string;
}

const LOOP_TIMEZONES: LoopTimezone[] = [
  { label: 'SANREMO', timezone: 'Europe/Rome' },
  { label: 'NEW YORK', timezone: 'America/New_York' },
  { label: 'MADRID', timezone: 'Europe/Madrid' },
  { label: 'MONTEVIDEO', timezone: 'America/Montevideo' },
  { label: 'SANTIAGO', timezone: 'America/Santiago' }
];

const COMING_SOON_PHRASES = ['YA VIENE', 'COMING SOON', 'IN ARRIVO'];

export default function RelojDigitalLoopClock({ timezone = 'Europe/Rome', title = 'MODOSANREMO NONSTOP' }: RelojDigitalLoopClockProps) {
  const defaultIndex = useMemo(() => {
    const idx = LOOP_TIMEZONES.findIndex((item) => item.timezone === timezone);
    return idx >= 0 ? idx : 0;
  }, [timezone]);

  const [activeIndex, setActiveIndex] = useState<number>(defaultIndex);
  const activeIndexRef = useRef(defaultIndex);
  const [clockOut, setClockOut] = useState(false);

  const [phraseIndex, setPhraseIndex] = useState(0);
  const phraseIndexRef = useRef(0);
  const [phraseOut, setPhraseOut] = useState(false);

  const clockRef = useRef<HTMLDivElement>(null);
  const msRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setActiveIndex(defaultIndex);
    activeIndexRef.current = defaultIndex;
  }, [defaultIndex]);

  // High-performance clock loop
  useEffect(() => {
    let rafId: number;
    const tick = () => {
      const now = new Date();
      const currentTz = LOOP_TIMEZONES[activeIndexRef.current].timezone;

      try {
        const fmt = new Intl.DateTimeFormat('en-GB', {
          timeZone: currentTz,
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
          hour12: false
        });
        const parts = fmt.formatToParts(now);
        const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '00';

        if (clockRef.current) {
          clockRef.current.textContent = `${get('hour')}:${get('minute')}:${get('second')}`;
        }
      } catch (e) {
        if (clockRef.current) {
          clockRef.current.textContent = now.toLocaleTimeString('en-GB', { timeZone: currentTz, hour12: false });
        }
      }

      if (msRef.current) {
        const cs = String(Math.floor(now.getMilliseconds() / 10)).padStart(2, '0');
        msRef.current.textContent = cs;
      }

      // Aim for smooth ~16-30ms refresh
      rafId = requestAnimationFrame(() => {
        setTimeout(tick, 20);
      });
    };
    tick();
    return () => cancelAnimationFrame(rafId);
  }, []);

  // Update rotation interval
  useEffect(() => {
    const id = window.setInterval(() => {
      const now = new Date();
      const secs = now.getSeconds();

      // Clock rotation every 30s
      if (secs % 30 === 0) {
        setClockOut(true);
        setTimeout(() => {
          const next = (activeIndexRef.current + 1) % LOOP_TIMEZONES.length;
          activeIndexRef.current = next;
          setActiveIndex(next);
          setClockOut(false);
        }, 500);
      }

      // "Coming soon" rotation every 15s
      // Slightly offset or aligned with 15/30/45/0 offsets
      if (secs % 15 === 0) {
        setPhraseOut(true);
        setTimeout(() => {
          const next = (phraseIndexRef.current + 1) % COMING_SOON_PHRASES.length;
          phraseIndexRef.current = next;
          setPhraseIndex(next);
          setPhraseOut(false);
        }, 400); // Wait 400ms to swap text naturally while hidden
      }
    }, 1000);
    return () => window.clearInterval(id);
  }, []);

  const active = LOOP_TIMEZONES[activeIndex] || LOOP_TIMEZONES[0];
  const phrase = COMING_SOON_PHRASES[phraseIndex];

  return (
    <div className='reloj-digital-loop-root'>
      <div id='logo-top-right'>
        <img src='/mi.png' alt='Modo Italiano' />
      </div>
      <div id='clock-block' className={clockOut ? 'clock-out' : ''}>
        <div id='clock-row'>
          <div id='clock-bg'>
            <div id='clock' ref={clockRef}>
              00:00:00
            </div>
          </div>
          <div id='ms-bg'>
            <div id='ms' ref={msRef}>
              00
            </div>
          </div>
        </div>
        <div id='city-name'>{active.label}</div>
      </div>
      <div id='lower-third'>
        <div id='coming-soon' className={phraseOut ? 'out' : ''}>
          {phrase}
        </div>
        <div id='pipe'>|</div>
        <div id='show-title'>{title}</div>
      </div>
    </div>
  );
}
