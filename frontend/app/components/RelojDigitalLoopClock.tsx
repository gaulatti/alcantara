import { useEffect, useMemo, useRef, useState } from 'react';
import { normalizeProgramTextSequence, resolveProgramTextLeaf } from '../utils/programSequence';
import { activateScene } from '../services/program';
import './RelojDigitalLoopClock.css';

interface RelojDigitalLoopClockProps {
  timezone?: string;
  textSequence?: unknown;
  ctaSequence?: unknown;
  programId?: string;
  mode?: 'clock' | 'countdown';
  countdownDuration?: number;
  countdownTargetSceneId?: number | null;
  countdownTransitionId?: string | null;
  countdownCommand?: number;
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
        const next = targetChars.map((targetChar, i) => {
          const settleFrame = 5 + i * 2;
          if (frame >= settleFrame) {
            return targetChar;
          }

          allDone = false;
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

export default function RelojDigitalLoopClock({
  timezone = 'Europe/Rome',
  textSequence,
  ctaSequence,
  programId,
  mode = 'clock',
  countdownDuration = 300,
  countdownTargetSceneId,
  countdownTransitionId = 'cut',
  countdownCommand
}: RelojDigitalLoopClockProps) {
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

  const countdownFiredRef = useRef(false);
  const countdownAnchorRef = useRef(0);
  const lastCommandRef = useRef(0);
  const initializedRef = useRef(false);
  const [countdownRunning, setCountdownRunning] = useState(false);

  useEffect(() => {
    if (!initializedRef.current) {
      initializedRef.current = true;
      lastCommandRef.current = countdownCommand || 0;
      return;
    }

    const cmd = countdownCommand || 0;
    if (cmd > lastCommandRef.current) {
      lastCommandRef.current = cmd;
      if (countdownRunning) {
        setCountdownRunning(false);
        countdownFiredRef.current = true;
      } else {
        countdownAnchorRef.current = Date.now();
        countdownFiredRef.current = false;
        setCountdownRunning(true);
      }
    }
  }, [countdownCommand]);

  useEffect(() => {
    if (!shouldTick) return;
    const timer = window.setInterval(() => setNowMs(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [shouldTick, normalizedTextSequence?.mode, normalizedCtaSequence?.mode]);

  const clockRef = useRef<HTMLDivElement>(null);
  const msRef = useRef<HTMLDivElement>(null);
  const labelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setActiveIndex(defaultIndex);
    activeIndexRef.current = defaultIndex;
  }, [defaultIndex]);

  const prevDurationRef = useRef(countdownDuration);

  useEffect(() => {
    if (countdownRunning && countdownDuration !== prevDurationRef.current) {
      countdownAnchorRef.current = Date.now();
      countdownFiredRef.current = false;
    }
    prevDurationRef.current = countdownDuration;
  }, [countdownDuration, countdownRunning]);

  useEffect(() => {
    if (mode !== 'countdown') return;

    let rafId: number;
    let animationId: number;

    const tick = () => {
      let remaining: number;

      if (countdownRunning) {
        const now = Date.now();
        const elapsed = now - countdownAnchorRef.current;
        remaining = Math.max(0, countdownDuration * 1000 - elapsed);
      } else if (countdownFiredRef.current) {
        remaining = 0;
      } else {
        remaining = countdownDuration * 1000;
      }

      const totalCs = Math.floor(remaining / 10);
      const cs = totalCs % 100;
      const totalSeconds = Math.floor(remaining / 1000);
      const seconds = totalSeconds % 60;
      const totalMinutes = Math.floor(totalSeconds / 60);
      const minutes = totalMinutes % 60;
      const hours = Math.floor(totalMinutes / 60);

      const timeStr = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;

      if (clockRef.current) {
        clockRef.current.textContent = timeStr;
      }
      if (msRef.current) {
        msRef.current.textContent = String(cs).padStart(2, '0');
      }
      if (labelRef.current) {
        labelRef.current.textContent = countdownRunning ? 'COUNTDOWN' : '';
      }

      if (countdownRunning && remaining <= 0 && !countdownFiredRef.current) {
        countdownFiredRef.current = true;
        if (programId && countdownTargetSceneId) {
          activateScene(programId, countdownTargetSceneId, countdownTransitionId);
        }
        return;
      }

      rafId = requestAnimationFrame(() => {
        animationId = window.setTimeout(tick, 20);
      });
    };

    tick();

    return () => {
      cancelAnimationFrame(rafId);
      window.clearTimeout(animationId);
    };
  }, [mode, countdownRunning, countdownDuration, countdownTargetSceneId, countdownTransitionId, programId]);

  useEffect(() => {
    if (mode !== 'clock') return;

    let rafId: number;
    let timerId: number;

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

      if (labelRef.current) {
        labelRef.current.textContent = LOOP_TIMEZONES[activeIndexRef.current].label;
      }

      rafId = requestAnimationFrame(() => {
        timerId = window.setTimeout(tick, 20);
      });
    };
    tick();
    return () => {
      cancelAnimationFrame(rafId);
      window.clearTimeout(timerId);
    };
  }, [mode]);

  useEffect(() => {
    if (mode !== 'clock') return;

    const id = window.setInterval(() => {
      const now = new Date();
      const secs = now.getSeconds();

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
  }, [mode]);

  const active = LOOP_TIMEZONES[activeIndex] || LOOP_TIMEZONES[0];

  const activeTitleItem = resolveProgramTextLeaf({ contentMode: 'sequence', sequence: normalizedTextSequence }, nowMs);
  const activeCtaItem = resolveProgramTextLeaf({ contentMode: 'sequence', sequence: normalizedCtaSequence }, nowMs);

  const titleText = activeTitleItem?.text?.trim() || '';
  const ctaText = activeCtaItem?.text?.trim() || '';

  return (
    <div className='reloj-digital-loop-root'>
      <div id='clock-block' className={clockOut && mode === 'clock' ? 'clock-out' : ''}>
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
        <div id='city-name' ref={labelRef}>{active.label}</div>
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
