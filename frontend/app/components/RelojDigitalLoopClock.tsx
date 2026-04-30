import { useEffect, useMemo, useRef, useState } from 'react';
import { normalizeProgramTextSequence, resolveProgramTextLeaf } from '../utils/programSequence';
import './RelojDigitalLoopClock.css';

interface RelojDigitalLoopClockProps {
  timezone?: string;
  textSequence?: unknown;
  ctaSequence?: unknown;
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

const FLIGHT_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789,.!? ';

function FlightBoardText({ targetText }: { targetText: string }) {
  const [displayArray, setDisplayArray] = useState<string[]>([]);
  const targetChars = useMemo(() => targetText.split(''), [targetText]);

  useEffect(() => {
    setDisplayArray((prev) => {
      const start = prev.slice(0, targetChars.length);
      while (start.length < targetChars.length) start.push(' ');
      return start;
    });

    let frame = 0;
    const intervalId = window.setInterval(() => {
      frame++;
      setDisplayArray((prev) => {
        let allDone = true;
        // Map over targetChars so array size matches current text precisely
        const next = targetChars.map((targetChar, i) => {
          // Speed: 2 frames per character index delay to settle
          const settleFrame = 5 + i * 2;
          if (frame >= settleFrame) {
            return targetChar;
          }

          allDone = false;
          // Random flip simulation
          return FLIGHT_CHARS[Math.floor(Math.random() * FLIGHT_CHARS.length)];
        });

        if (allDone) window.clearInterval(intervalId);
        return next;
      });
    }, 45);

    return () => window.clearInterval(intervalId);
  }, [targetChars]);

  return <>{displayArray.join('')}</>;
}

export default function RelojDigitalLoopClock({ timezone = 'Europe/Rome', textSequence, ctaSequence }: RelojDigitalLoopClockProps) {
  const defaultIndex = useMemo(() => {
    const idx = LOOP_TIMEZONES.findIndex((item) => item.timezone === timezone);
    return idx >= 0 ? idx : 0;
  }, [timezone]);

  const [activeIndex, setActiveIndex] = useState<number>(defaultIndex);
  const activeIndexRef = useRef(defaultIndex);
  const [clockOut, setClockOut] = useState(false);

  const [nowMs, setNowMs] = useState(() => Date.now());
  const normalizedTextSequence = useMemo(() => normalizeProgramTextSequence(textSequence), [textSequence]);
  const normalizedCtaSequence = useMemo(() => normalizeProgramTextSequence(ctaSequence), [ctaSequence]);
  const shouldTick = normalizedTextSequence?.mode === 'autoplay' || normalizedCtaSequence?.mode === 'autoplay';

  useEffect(() => {
    if (!shouldTick) return;
    const timer = window.setInterval(() => setNowMs(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [shouldTick, normalizedTextSequence?.mode, normalizedCtaSequence?.mode]);

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
    }, 1000);
    return () => window.clearInterval(id);
  }, []);

  const active = LOOP_TIMEZONES[activeIndex] || LOOP_TIMEZONES[0];

  const activeTitleItem = resolveProgramTextLeaf({ contentMode: 'sequence', sequence: normalizedTextSequence }, nowMs);
  const activeCtaItem = resolveProgramTextLeaf({ contentMode: 'sequence', sequence: normalizedCtaSequence }, nowMs);

  const titleText = activeTitleItem?.text?.trim() || '';
  const ctaText = activeCtaItem?.text?.trim() || '';

  return (
    <div className='reloj-digital-loop-root'>
      <div id='clock-block' className={clockOut ? 'clock-out' : ''}>
        <div id='logo-above'>
          <img src='/mi.svg' alt='Modo Italiano' />
        </div>
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
      {(titleText !== '' || ctaText !== '') && (
        <div id='lower-third'>
          {ctaText !== '' && (
            <div id='cta' className={activeCtaItem?.mode === 'in' ? 'in-anim' : activeCtaItem?.mode === 'out' ? 'out' : ''}>
              {ctaText}
            </div>
          )}
          {titleText !== '' && ctaText !== '' && <div id='pipe'>|</div>}
          {titleText !== '' && (
            <div id='show-title'>
              <FlightBoardText targetText={titleText} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
