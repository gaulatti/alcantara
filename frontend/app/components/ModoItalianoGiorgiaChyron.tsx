import React, { useEffect, useMemo, useState } from 'react';
import { normalizeProgramTextSequence, resolveProgramTextLeaf } from '../utils/programSequence';
import { GIORGIA, GiorgiaGrade, GiorgiaRule, fitGiorgiaText, giorgiaLabelStyle, useElementWidth } from './giorgiaBroadcast';

interface ModoItalianoGiorgiaChyronProps {
  show?: boolean;
  textSequence?: unknown;
  ctaSequence?: unknown;
  inline?: boolean;
}

const HEADLINE_MAX_PX = 120;
const HEADLINE_MIN_PX = 76;
const MARQUEE_PX = 96;
/** Average glyph advance of uppercase Barlow Condensed 800, as a fraction of the font size. */
const HEADLINE_GLYPH = 0.5;
const TEXT_INSET_PX = GIORGIA.ruleWidth + 28;
/** Width assumed until the block is measured (the full row between the safe edges). */
const UNMEASURED_WIDTH_PX = 1920 - GIORGIA.safeX * 2;

/**
 * Giorgia headline: a fitted line of condensed type hanging from the magenta
 * rule, set on a navy grade. It appears and disappears with hard cuts.
 */
export const ModoItalianoGiorgiaChyron: React.FC<ModoItalianoGiorgiaChyronProps> = ({
  show = true,
  textSequence,
  ctaSequence,
  inline = false
}) => {
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [blockRef, blockWidth] = useElementWidth<HTMLDivElement>();
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

  const textLeaf = resolveProgramTextLeaf({ contentMode: 'sequence', sequence: normalizedTextSequence }, nowMs, { includeMarquee: true });
  const ctaLeaf = resolveProgramTextLeaf({ contentMode: 'sequence', sequence: normalizedCtaSequence }, nowMs);
  const headline = (textLeaf?.text.trim() ?? '').toUpperCase();
  const useMarquee = Boolean(textLeaf?.useMarquee);
  const cta = ctaLeaf?.text.trim() ?? '';

  if (!show || !headline) return null;

  const availableWidth = (blockWidth || UNMEASURED_WIDTH_PX) - TEXT_INSET_PX;
  // A headline too long for one line at the smallest size wraps to two; it is never cut with an ellipsis.
  const wraps = headline.length * HEADLINE_GLYPH * HEADLINE_MIN_PX > availableWidth;
  const headlineSize = wraps ? HEADLINE_MIN_PX : fitGiorgiaText(headline, availableWidth, HEADLINE_MAX_PX, HEADLINE_MIN_PX, HEADLINE_GLYPH);

  const headlineStyle: React.CSSProperties = {
    margin: 0,
    color: '#ffffff',
    fontFamily: GIORGIA.display,
    fontWeight: 800,
    letterSpacing: '-0.03em',
    textShadow: GIORGIA.displayShadow
  };

  return (
    <div
      ref={blockRef}
      className='modoitaliano-giorgia-chyron'
      aria-label='Modo Italiano Giorgia chyron'
      style={{
        paddingLeft: `${TEXT_INSET_PX}px`,
        ...(inline
          ? { position: 'relative', width: '100%' }
          : { position: 'absolute', left: `${GIORGIA.safeX}px`, right: `${GIORGIA.safeX}px`, bottom: `${GIORGIA.safeBottom}px`, zIndex: 950 })
      }}
    >
      <style>{`
        @keyframes modoItalianoGiorgiaChyronMarquee {
          from { transform: translateX(0); }
          to { transform: translateX(-50%); }
        }
        @media (prefers-reduced-motion: reduce) {
          .modoitaliano-giorgia-chyron-marquee { animation: none !important; }
        }
      `}</style>
      <GiorgiaGrade />
      <GiorgiaRule />
      {cta ? <div style={{ ...giorgiaLabelStyle, color: GIORGIA.signal, marginBottom: '16px', overflow: 'hidden' }}>{cta}</div> : null}
      {useMarquee ? (
        <div style={{ ...headlineStyle, fontSize: `${MARQUEE_PX}px`, lineHeight: 1, whiteSpace: 'nowrap', overflow: 'hidden' }}>
          {/* Two identical halves, each carrying its own trailing space, so -50% lands exactly on the seam. */}
          <div
            className='modoitaliano-giorgia-chyron-marquee'
            style={{ display: 'inline-flex', animation: 'modoItalianoGiorgiaChyronMarquee 20s linear infinite' }}
          >
            <span style={{ paddingRight: '96px' }}>{headline}</span>
            <span aria-hidden='true' style={{ paddingRight: '96px' }}>
              {headline}
            </span>
          </div>
        </div>
      ) : (
        <h2
          className='modoitaliano-giorgia-chyron-headline'
          style={{
            ...headlineStyle,
            fontSize: `${headlineSize}px`,
            lineHeight: 0.9,
            // Room for descenders and accents that the tight leading would otherwise clip.
            padding: '0.06em 0',
            ...(wraps
              ? { textWrap: 'balance', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }
              : { whiteSpace: 'nowrap' })
          }}
        >
          {headline}
        </h2>
      )}
    </div>
  );
};
