import React, { useLayoutEffect, useState } from 'react';

/**
 * Giorgia's broadcast language, taken from the artist bumper in
 * `@modoitaliano/giorgia` and the Giorgia templates in Broadway: square
 * geometry, one magenta signal rule, condensed type set straight on the
 * picture over a navy grade, and hard cuts.
 */
export const GIORGIA = {
  navy: '#0a1234',
  signal: '#ed0076',
  display: "'Barlow Condensed', system-ui, sans-serif",
  text: "'Barlow', system-ui, sans-serif",
  /** Shared left/right edge for every block on the 1920x1080 canvas. */
  safeX: 82,
  safeTop: 68,
  safeBottom: 70,
  ruleWidth: 10,
  labelSize: 31,
  displayShadow: '0 8px 34px rgba(0,0,0,0.66)',
  labelShadow: '0 3px 16px rgba(0,0,0,0.65)',
  /** Opaque navy of the key-safe plates: the colour the grade reaches at its densest. */
  plate: '#070d2b',
  /** Navy kept clear around type on a key-safe plate. */
  platePadding: 44
} as const;

/** Uppercase eyebrow style shared by the clock, the on-air label and the chyron call to action. */
export const giorgiaLabelStyle: React.CSSProperties = {
  fontFamily: GIORGIA.display,
  fontSize: `${GIORGIA.labelSize}px`,
  fontWeight: 700,
  lineHeight: 1,
  letterSpacing: '0.13em',
  textTransform: 'uppercase',
  textShadow: GIORGIA.labelShadow,
  whiteSpace: 'nowrap'
};

/** Largest font size, within bounds, at which `text` fits `availableWidth` on one line. */
export function fitGiorgiaText(text: string, availableWidth: number, maximum: number, minimum: number, approximateGlyphWidth: number): number {
  return Math.max(minimum, Math.min(maximum, availableWidth / (Math.max(1, text.length) * approximateGlyphWidth)));
}

/** Tracks an element's rendered width; reports 0 until it is measured. */
export function useElementWidth<T extends HTMLElement>(): [(node: T | null) => void, number] {
  const [node, setNode] = useState<T | null>(null);
  const [width, setWidth] = useState(0);

  useLayoutEffect(() => {
    if (!node) return;
    setWidth(node.clientWidth);
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => setWidth(node.clientWidth));
    observer.observe(node);
    return () => observer.disconnect();
  }, [node]);

  return [setNode, width];
}

/** Tracks an element's rendered height; reports 0 until it is measured. */
export function useElementHeight<T extends HTMLElement>(): [(node: T | null) => void, number] {
  const [node, setNode] = useState<T | null>(null);
  const [height, setHeight] = useState(0);

  useLayoutEffect(() => {
    if (!node) return;
    setHeight(node.clientHeight);
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => setHeight(node.clientHeight));
    observer.observe(node);
    return () => observer.disconnect();
  }, [node]);

  return [setNode, height];
}

/** The ModoItaliano circle, square and triangle mark, in white. */
export function GiorgiaMark({ width = 172, keySafe = false }: { width?: number; keySafe?: boolean }) {
  return (
    <svg
      aria-label='ModoItaliano'
      role='img'
      viewBox='0 0 595.27 206.59'
      width={width}
      style={{ display: 'block', flexShrink: 0, overflow: 'visible', filter: keySafe ? undefined : 'drop-shadow(0 6px 24px rgba(0,0,0,0.6))' }}
    >
      <path fill='#fff' d='M160.26 103.3c0 44.25-35.88 80.13-80.12 80.13S0 147.55 0 103.3s35.87-80.14 80.14-80.14c44.25 0 80.12 35.88 80.12 80.14Z' />
      <rect fill='#fff' x='211.95' y='23.16' width='160.26' height='160.27' />
      <path fill='#fff' d='m415.46 181.15 89.9-155.71 89.91 155.71H415.46Z' />
    </svg>
  );
}

/** The magenta signal rule that every Giorgia text block hangs from. */
export function GiorgiaRule({ left = 0, keySafe = false }: { left?: number; keySafe?: boolean }) {
  return (
    <div
      aria-hidden='true'
      data-giorgia-rule
      style={{
        position: 'absolute',
        top: 0,
        bottom: 0,
        left: `${left}px`,
        width: `${GIORGIA.ruleWidth}px`,
        background: GIORGIA.signal,
        boxShadow: keySafe ? undefined : '0 0 30px rgba(237,0,118,0.3)'
      }}
    />
  );
}

/**
 * Full-bleed navy grade behind a text block, so type sits on the picture
 * rather than in a box. It paints behind everything in the nearest stacking
 * context: the block itself when standalone, the shared row when inline, so
 * one block's grade never covers a neighbour's text. For that to hold, the
 * element the grade sits in must not create a stacking context of its own when
 * inline: no transform, opacity or filter on it. Animate an inner wrapper and
 * pass the grade its own fade through `style`.
 *
 * Key-safe, for scenes shot over a chroma key, the grade is a solid navy band
 * with a hard top edge instead of a gradient. Anything partly transparent over
 * the key colour, and any type whose edges blend into it, comes out of the
 * keyer as a dirty fringe; magenta on green is the worst case. On an opaque
 * band the type only ever blends into navy. The band also appears and
 * disappears with a cut, since a fade is partly transparent while it runs.
 */
export function GiorgiaGrade({ style, keySafe = false }: { style?: React.CSSProperties; keySafe?: boolean }) {
  return (
    <div
      aria-hidden='true'
      data-giorgia-grade
      style={{
        position: 'absolute',
        zIndex: -1,
        left: '-1920px',
        right: '-1920px',
        top: '-150px',
        bottom: '-400px',
        background: 'linear-gradient(0deg, rgba(7,13,43,0.94) 0%, rgba(7,13,43,0.9) 55%, rgba(7,13,43,0.5) 82%, rgba(7,13,43,0) 100%)',
        pointerEvents: 'none',
        ...style,
        ...(keySafe ? { top: `-${GIORGIA.platePadding}px`, background: GIORGIA.plate, transition: 'none' } : null)
      }}
    />
  );
}
