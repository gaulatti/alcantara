import React, { useEffect, useMemo, useRef, useState } from 'react';
import { normalizeProgramTextSequence, resolveProgramTextLeaf } from '../utils/programSequence';

interface ModoItalianoGiorgiaChyronProps {
  show?: boolean;
  textSequence?: unknown;
  ctaSequence?: unknown;
  inline?: boolean;
}

const SIGNAL = '#ed0076';
const SWAP_MS = 220;

export const ModoItalianoGiorgiaChyron: React.FC<ModoItalianoGiorgiaChyronProps> = ({
  show = true,
  textSequence,
  ctaSequence,
  inline = false
}) => {
  const [nowMs, setNowMs] = useState(() => Date.now());
  const normalizedTextSequence = useMemo(
    () => normalizeProgramTextSequence(textSequence, 0, { includeMarquee: true }),
    [textSequence]
  );
  const normalizedCtaSequence = useMemo(() => normalizeProgramTextSequence(ctaSequence), [ctaSequence]);
  const shouldTick = normalizedTextSequence?.mode === 'autoplay' || normalizedCtaSequence?.mode === 'autoplay';

  useEffect(() => {
    if (!shouldTick) return;
    const timer = window.setInterval(() => setNowMs(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [
    shouldTick,
    normalizedTextSequence?.mode,
    normalizedTextSequence?.startedAt,
    normalizedTextSequence?.intervalMs,
    normalizedTextSequence?.loop,
    normalizedTextSequence?.items.length,
    normalizedCtaSequence?.mode,
    normalizedCtaSequence?.startedAt,
    normalizedCtaSequence?.intervalMs,
    normalizedCtaSequence?.loop,
    normalizedCtaSequence?.items.length
  ]);

  useEffect(() => setNowMs(Date.now()), [textSequence, ctaSequence]);

  const resolvedTextLeaf = resolveProgramTextLeaf(
    { contentMode: 'sequence', sequence: normalizedTextSequence },
    nowMs,
    { includeMarquee: true }
  );
  const resolvedCtaLeaf = resolveProgramTextLeaf({ contentMode: 'sequence', sequence: normalizedCtaSequence }, nowMs);
  const resolvedMainText = resolvedTextLeaf?.text.trim() ?? '';
  const resolvedUseMarquee = Boolean(resolvedTextLeaf?.useMarquee);
  const resolvedCtaText = resolvedCtaLeaf?.text.trim() ?? '';

  const [displayMainText, setDisplayMainText] = useState(resolvedMainText);
  const [displayUseMarquee, setDisplayUseMarquee] = useState(resolvedUseMarquee);
  const [mainTextActive, setMainTextActive] = useState(true);
  const [displayCtaText, setDisplayCtaText] = useState(resolvedCtaText);
  const [ctaActive, setCtaActive] = useState(true);
  const shouldShow = Boolean(show && resolvedMainText);
  const [isMounted, setIsMounted] = useState(shouldShow);
  const [isVisible, setIsVisible] = useState(shouldShow);
  const mainTimer = useRef<number | null>(null);
  const ctaTimer = useRef<number | null>(null);
  const visibilityTimer = useRef<number | null>(null);
  const visibilityFrame = useRef<number | null>(null);

  useEffect(() => {
    if (visibilityTimer.current !== null) window.clearTimeout(visibilityTimer.current);
    if (visibilityFrame.current !== null) window.cancelAnimationFrame(visibilityFrame.current);

    if (shouldShow) {
      setIsMounted(true);
      visibilityFrame.current = window.requestAnimationFrame(() => {
        setIsVisible(true);
        visibilityFrame.current = null;
      });
      return;
    }

    setIsVisible(false);
    visibilityTimer.current = window.setTimeout(() => {
      setIsMounted(false);
      visibilityTimer.current = null;
    }, SWAP_MS);
  }, [shouldShow]);

  useEffect(() => {
    if (resolvedMainText === displayMainText && resolvedUseMarquee === displayUseMarquee) return;
    if (mainTimer.current !== null) window.clearTimeout(mainTimer.current);
    setMainTextActive(false);
    mainTimer.current = window.setTimeout(() => {
      setDisplayMainText(resolvedMainText);
      setDisplayUseMarquee(resolvedUseMarquee);
      setMainTextActive(true);
      mainTimer.current = null;
    }, SWAP_MS);
  }, [resolvedMainText, resolvedUseMarquee, displayMainText, displayUseMarquee]);

  useEffect(() => {
    if (resolvedCtaText === displayCtaText) return;
    if (ctaTimer.current !== null) window.clearTimeout(ctaTimer.current);
    setCtaActive(false);
    ctaTimer.current = window.setTimeout(() => {
      setDisplayCtaText(resolvedCtaText);
      setCtaActive(true);
      ctaTimer.current = null;
    }, SWAP_MS);
  }, [resolvedCtaText, displayCtaText]);

  useEffect(
    () => () => {
      if (mainTimer.current !== null) window.clearTimeout(mainTimer.current);
      if (ctaTimer.current !== null) window.clearTimeout(ctaTimer.current);
      if (visibilityTimer.current !== null) window.clearTimeout(visibilityTimer.current);
      if (visibilityFrame.current !== null) window.cancelAnimationFrame(visibilityFrame.current);
    },
    []
  );

  if (!isMounted) return null;

  const wrapperStyle: React.CSSProperties = inline
    ? {
        width: '100%',
        opacity: isVisible ? 1 : 0,
        transform: isVisible ? 'translateY(0px)' : 'translateY(8px)',
        transition: `opacity ${SWAP_MS}ms ease, transform ${SWAP_MS}ms ease`
      }
    : {
        position: 'absolute',
        left: '110px',
        right: '110px',
        bottom: '110px',
        zIndex: 950,
        opacity: isVisible ? 1 : 0,
        transform: isVisible ? 'translateY(0px)' : 'translateY(8px)',
        transition: `opacity ${SWAP_MS}ms ease, transform ${SWAP_MS}ms ease`
      };
  const textMotion: React.CSSProperties = {
    opacity: mainTextActive ? 1 : 0,
    transform: mainTextActive ? 'translateY(0px)' : 'translateY(10px)',
    transition: `opacity ${SWAP_MS}ms ease, transform ${SWAP_MS}ms ease`
  };
  const headline = displayMainText.toUpperCase();

  return (
    <div className='modoitaliano-giorgia-chyron' style={wrapperStyle} aria-label='Modo Italiano Giorgia chyron'>
      <style>{`
        @keyframes modoItalianoGiorgiaChyronBgFlow {
          0% { background-position: 0% 50%; }
          50% { background-position: 100% 50%; }
          100% { background-position: 0% 50%; }
        }
        @keyframes modoItalianoGiorgiaChyronMarquee {
          from { transform: translateX(0); }
          to { transform: translateX(-50%); }
        }
        @media (prefers-reduced-motion: reduce) {
          .modoitaliano-giorgia-chyron,
          .modoitaliano-giorgia-chyron * { transition-duration: 0.01ms !important; }
          .modoitaliano-giorgia-chyron-panel,
          .modoitaliano-giorgia-chyron-marquee { animation: none !important; }
        }
      `}</style>
      {displayCtaText ? (
        <div
          style={{
            width: '100%',
            marginBottom: '14px',
            paddingLeft: '34px',
            color: '#ffffff',
            fontFamily: "'Barlow Condensed', 'Encode Sans', system-ui, sans-serif",
            fontSize: '30px',
            fontWeight: 700,
            lineHeight: 1,
            letterSpacing: '0.08em',
            textAlign: 'left',
            textTransform: 'uppercase',
            textShadow: '0 4px 18px rgba(0,0,0,0.96)',
            opacity: ctaActive ? 1 : 0,
            transform: ctaActive ? 'translateY(0px)' : 'translateY(6px)',
            transition: `opacity ${SWAP_MS}ms ease, transform ${SWAP_MS}ms ease`,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis'
          }}
        >
          {displayCtaText}
        </div>
      ) : null}
      <div
        className='modoitaliano-giorgia-chyron-panel'
        style={{
          position: 'relative',
          height: '150px',
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          overflow: 'hidden',
          background: 'linear-gradient(125deg, #080d2a 0%, #111c50 48%, #080d2a 100%)',
          backgroundSize: '200% 200%',
          animation: 'modoItalianoGiorgiaChyronBgFlow 8s ease-in-out infinite',
          borderLeft: `10px solid ${SIGNAL}`,
          boxShadow: '0 24px 54px rgba(0,0,0,0.72)',
          padding: '0 42px'
        }}
      >
        <div
          aria-hidden='true'
          style={{ position: 'absolute', top: 0, left: 0, right: 0, height: '4px', background: SIGNAL }}
        />
        <div
          style={{
            width: '100%',
            color: '#ffffff',
            fontFamily: "'Barlow Condensed', 'Encode Sans', system-ui, sans-serif",
            fontSize: '70px',
            fontWeight: 700,
            lineHeight: 1,
            letterSpacing: '0.02em',
            textTransform: 'uppercase',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textAlign: 'left'
          }}
        >
          {displayUseMarquee ? (
            <div style={{ ...textMotion, width: '100%', overflow: 'hidden' }}>
              <div
                className='modoitaliano-giorgia-chyron-marquee'
                style={{ display: 'inline-flex', gap: '96px', minWidth: '200%', animation: 'modoItalianoGiorgiaChyronMarquee 20s linear infinite' }}
              >
                <span>{headline}</span>
                <span>{headline}</span>
              </div>
            </div>
          ) : (
            <div style={{ ...textMotion, overflow: 'hidden', textOverflow: 'ellipsis' }}>{headline}</div>
          )}
        </div>
      </div>
    </div>
  );
};
