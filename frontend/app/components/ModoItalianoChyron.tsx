import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  normalizeModoItalianoTextSequence,
  resolveModoItalianoTextLeaf
} from '../utils/modoItalianoSequence';

interface ModoItalianoChyronProps {
  show?: boolean;
  textSequence?: unknown;
  ctaSequence?: unknown;
  inline?: boolean;
}

const CHYRON_SWAP_MS = 220;

export const ModoItalianoChyron: React.FC<ModoItalianoChyronProps> = ({
  show = true,
  textSequence,
  ctaSequence,
  inline = false
}) => {
  const [nowMs, setNowMs] = useState(() => Date.now());
  const normalizedTextSequence = useMemo(
    () => normalizeModoItalianoTextSequence(textSequence, 0, { includeMarquee: true }),
    [textSequence]
  );
  const normalizedCtaSequence = useMemo(
    () => normalizeModoItalianoTextSequence(ctaSequence),
    [ctaSequence]
  );
  const shouldTick = normalizedTextSequence?.mode === 'autoplay' || normalizedCtaSequence?.mode === 'autoplay';

  useEffect(() => {
    if (!shouldTick) {
      return;
    }

    const timer = window.setInterval(() => {
      setNowMs(Date.now());
    }, 250);

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

  useEffect(() => {
    setNowMs(Date.now());
  }, [textSequence, ctaSequence]);

  const resolvedTextLeaf = resolveModoItalianoTextLeaf(
    {
      contentMode: 'sequence',
      sequence: normalizedTextSequence
    },
    nowMs,
    { includeMarquee: true }
  );
  const resolvedCtaLeaf = resolveModoItalianoTextLeaf(
    {
      contentMode: 'sequence',
      sequence: normalizedCtaSequence
    },
    nowMs
  );
  const resolvedMainText = resolvedTextLeaf?.text.trim() ?? '';
  const resolvedUseMarquee = Boolean(resolvedTextLeaf?.useMarquee);
  const resolvedCtaText = resolvedCtaLeaf?.text.trim() ?? '';

  const [displayMainText, setDisplayMainText] = useState(resolvedMainText);
  const [displayUseMarquee, setDisplayUseMarquee] = useState(resolvedUseMarquee);
  const [mainTextActive, setMainTextActive] = useState(true);
  const [displayCtaText, setDisplayCtaText] = useState(resolvedCtaText);
  const [ctaActive, setCtaActive] = useState(true);
  const shouldShowChyron = Boolean(show && resolvedMainText);
  const [isMounted, setIsMounted] = useState(shouldShowChyron);
  const [isVisible, setIsVisible] = useState(shouldShowChyron);
  const mainTextSwapTimerRef = useRef<number | null>(null);
  const ctaSwapTimerRef = useRef<number | null>(null);
  const visibilityTimerRef = useRef<number | null>(null);
  const visibilityFrameRef = useRef<number | null>(null);

  useEffect(() => {
    if (visibilityTimerRef.current !== null) {
      window.clearTimeout(visibilityTimerRef.current);
      visibilityTimerRef.current = null;
    }
    if (visibilityFrameRef.current !== null) {
      window.cancelAnimationFrame(visibilityFrameRef.current);
      visibilityFrameRef.current = null;
    }

    if (shouldShowChyron) {
      setIsMounted(true);
      visibilityFrameRef.current = window.requestAnimationFrame(() => {
        setIsVisible(true);
        visibilityFrameRef.current = null;
      });
      return;
    }

    setIsVisible(false);
    visibilityTimerRef.current = window.setTimeout(() => {
      setIsMounted(false);
      visibilityTimerRef.current = null;
    }, CHYRON_SWAP_MS);
  }, [shouldShowChyron]);

  useEffect(() => {
    if (resolvedMainText === displayMainText && resolvedUseMarquee === displayUseMarquee) {
      return;
    }

    if (mainTextSwapTimerRef.current !== null) {
      window.clearTimeout(mainTextSwapTimerRef.current);
      mainTextSwapTimerRef.current = null;
    }

    setMainTextActive(false);
    mainTextSwapTimerRef.current = window.setTimeout(() => {
      setDisplayMainText(resolvedMainText);
      setDisplayUseMarquee(resolvedUseMarquee);
      setMainTextActive(true);
      mainTextSwapTimerRef.current = null;
    }, CHYRON_SWAP_MS);
  }, [resolvedMainText, resolvedUseMarquee, displayMainText, displayUseMarquee]);

  useEffect(() => {
    if (resolvedCtaText === displayCtaText) {
      return;
    }

    if (ctaSwapTimerRef.current !== null) {
      window.clearTimeout(ctaSwapTimerRef.current);
      ctaSwapTimerRef.current = null;
    }

    setCtaActive(false);
    ctaSwapTimerRef.current = window.setTimeout(() => {
      setDisplayCtaText(resolvedCtaText);
      setCtaActive(true);
      ctaSwapTimerRef.current = null;
    }, CHYRON_SWAP_MS);
  }, [resolvedCtaText, displayCtaText]);

  useEffect(() => {
    return () => {
      if (mainTextSwapTimerRef.current !== null) {
        window.clearTimeout(mainTextSwapTimerRef.current);
        mainTextSwapTimerRef.current = null;
      }
      if (ctaSwapTimerRef.current !== null) {
        window.clearTimeout(ctaSwapTimerRef.current);
        ctaSwapTimerRef.current = null;
      }
      if (visibilityTimerRef.current !== null) {
        window.clearTimeout(visibilityTimerRef.current);
        visibilityTimerRef.current = null;
      }
      if (visibilityFrameRef.current !== null) {
        window.cancelAnimationFrame(visibilityFrameRef.current);
        visibilityFrameRef.current = null;
      }
    };
  }, []);

  if (!isMounted) {
    return null;
  }

  const wrapperStyle: React.CSSProperties = inline
    ? {
        width: '100%',
        opacity: isVisible ? 1 : 0,
        transform: isVisible ? 'translateY(0px)' : 'translateY(8px)',
        transition: `opacity ${CHYRON_SWAP_MS}ms ease, transform ${CHYRON_SWAP_MS}ms ease`
      }
    : {
        position: 'absolute',
        left: '110px',
        right: '110px',
        bottom: '110px',
        zIndex: 950,
        opacity: isVisible ? 1 : 0,
        transform: isVisible ? 'translateY(0px)' : 'translateY(8px)',
        transition: `opacity ${CHYRON_SWAP_MS}ms ease, transform ${CHYRON_SWAP_MS}ms ease`
      };

  const boxStyle: React.CSSProperties =
    {
      height: '140px',
      width: '100%',
      display: 'flex',
      alignItems: 'center',
      borderRadius: '50px',
      overflow: 'hidden',
      background: 'linear-gradient(125deg, #2b2b2b 0%, #1a1a1a 48%, #2b2b2b 100%)',
      backgroundSize: '200% 200%',
      animation: 'modoItalianoChyronBgFlow 8s ease-in-out infinite',
      boxShadow: '0 24px 44px rgba(0, 0, 0, 0.72)',
      filter: 'drop-shadow(0 12px 24px rgba(0, 0, 0, 0.52))',
      padding: '0 34px'
    };

  const ctaStyle: React.CSSProperties = {
    width: '100%',
    marginBottom: '18px',
    paddingLeft: '34px',
    color: '#ffffff',
    fontFamily: "'Outfit', 'Encode Sans', system-ui, sans-serif",
    fontSize: '38.4px',
    fontWeight: 500,
    lineHeight: 1,
    textAlign: 'left',
    textShadow: '0 4px 18px rgba(0, 0, 0, 0.96), 0 0 28px rgba(0, 0, 0, 0.72), 0 0 10px rgba(255, 255, 255, 0.2)',
    WebkitTextStroke: '0.7px rgba(0, 0, 0, 0.5)',
    opacity: ctaActive ? 1 : 0,
    transform: ctaActive ? 'translateY(0px)' : 'translateY(6px)',
    transition: `opacity ${CHYRON_SWAP_MS}ms ease, transform ${CHYRON_SWAP_MS}ms ease`,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis'
  };

  const contentStyle: React.CSSProperties = {
    width: '100%',
    color: '#ffffff',
    fontFamily: "'Barlow Condensed', 'Encode Sans', system-ui, sans-serif",
    fontSize: '84px',
    fontWeight: 600,
    lineHeight: 1,
    textTransform: 'uppercase',
    letterSpacing: '0.02em',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textAlign: 'center',
    justifyContent: 'center'
  };

  if (displayUseMarquee) {
    const marqueeText = displayMainText.toUpperCase();
    return (
      <div style={wrapperStyle}>
        {displayCtaText ? <div style={ctaStyle}>{displayCtaText}</div> : null}
        <div style={boxStyle}>
          <style>{`
          @keyframes modoItalianoChyronBgFlow {
            0% { background-position: 0% 50%; }
            50% { background-position: 100% 50%; }
            100% { background-position: 0% 50%; }
          }
          @keyframes modoItalianoChyronMarquee {
            from { transform: translateX(0); }
            to { transform: translateX(-50%); }
          }
        `}</style>
        <div
          style={{
            ...contentStyle,
            overflow: 'hidden',
            opacity: mainTextActive ? 1 : 0,
            transform: mainTextActive ? 'translateY(0px)' : 'translateY(10px)',
            transition: `opacity ${CHYRON_SWAP_MS}ms ease, transform ${CHYRON_SWAP_MS}ms ease`
          }}
        >
          <div
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '96px',
              minWidth: '200%',
              animation: 'modoItalianoChyronMarquee 20s linear infinite'
            }}
          >
            <span>{marqueeText}</span>
            <span>{marqueeText}</span>
          </div>
        </div>
        </div>
      </div>
    );
  }

  return (
    <div style={wrapperStyle}>
      {displayCtaText ? <div style={ctaStyle}>{displayCtaText}</div> : null}
      <div style={boxStyle}>
        <style>{`
          @keyframes modoItalianoChyronBgFlow {
            0% { background-position: 0% 50%; }
            50% { background-position: 100% 50%; }
            100% { background-position: 0% 50%; }
          }
        `}</style>
        <div
          style={{
            ...contentStyle,
            textOverflow: 'ellipsis',
            opacity: mainTextActive ? 1 : 0,
            transform: mainTextActive ? 'translateY(0px)' : 'translateY(10px)',
            transition: `opacity ${CHYRON_SWAP_MS}ms ease, transform ${CHYRON_SWAP_MS}ms ease`
          }}
        >
          {displayMainText.toUpperCase()}
        </div>
      </div>
    </div>
  );
};
