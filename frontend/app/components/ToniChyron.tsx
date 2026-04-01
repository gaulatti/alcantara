import React from 'react';
import './ToniChyron.css';
import {
  getToniChyronContentMode,
  normalizeToniChyronSequence,
  resolveToniChyronContent
} from '../utils/toniChyronSequence';

const LABELS = ['EN VIVO', 'LIVE'];
const LABEL_INTERVAL_MS = 4000;
const LABEL_FADE_MS = 350;
const DEFAULT_SOCIAL_HANDLES = ['@modoitaliano.oficial', '@fifth.bell', '@hnmages'];
const SOCIAL_INTERVAL_MS = 4000;

interface FifthBellChyronProps {
  text?: string;
  show?: boolean;
  useMarquee?: boolean;
  label?: string;
  contentMode?: 'text' | 'sequence';
  sequence?: unknown;
  socialHandles?: unknown;
}

function normalizeSocialHandles(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return DEFAULT_SOCIAL_HANDLES;
  }

  return value
    .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
    .filter((entry) => entry.length > 0);
}

export const FifthBellChyron: React.FC<FifthBellChyronProps> = ({
  text = '',
  show = false,
  useMarquee,
  label,
  contentMode,
  sequence,
  socialHandles: socialHandlesProp
}) => {
  const [visible, setVisible] = React.useState(show);
  const [nowMs, setNowMs] = React.useState(() => Date.now());
  const normalizedSequence = normalizeToniChyronSequence(sequence);
  const socialHandles = React.useMemo(() => normalizeSocialHandles(socialHandlesProp), [socialHandlesProp]);
  const isSequenceMode =
    getToniChyronContentMode(contentMode, normalizedSequence) === 'sequence';
  const resolvedContent = resolveToniChyronContent(
    {
      text,
      useMarquee,
      contentMode,
      sequence: normalizedSequence
    },
    nowMs
  );
  const [displayText, setDisplayText] = React.useState(resolvedContent.text);
  const [isChanging, setIsChanging] = React.useState(false);
  const [labelIndex, setLabelIndex] = React.useState(0);
  const [labelFading, setLabelFading] = React.useState(false);
  const labelIndexRef = React.useRef(0);
  const [socialIndex, setSocialIndex] = React.useState(0);
  const socialIndexRef = React.useRef(0);

  React.useEffect(() => {
    if (!isSequenceMode || !normalizedSequence) {
      return;
    }

    const timer = setInterval(() => {
      setNowMs(Date.now());
    }, 500);

    return () => clearInterval(timer);
  }, [isSequenceMode, sequence]);

  React.useEffect(() => {
    setVisible(show);
  }, [show]);

  React.useEffect(() => {
    if (resolvedContent.text !== displayText) {
      setIsChanging(true);
      const timer = setTimeout(() => {
        setDisplayText(resolvedContent.text);
        setIsChanging(false);
      }, 300);
      return () => clearTimeout(timer);
    }
  }, [resolvedContent.text, displayText]);

  // Cycle label only when no external label is forced
  React.useEffect(() => {
    if (label) return;
    const timer = setInterval(() => {
      setLabelFading(true);
      setTimeout(() => {
        const next = (labelIndexRef.current + 1) % LABELS.length;
        labelIndexRef.current = next;
        setLabelIndex(next);
        setLabelFading(false);
      }, LABEL_FADE_MS);
    }, LABEL_INTERVAL_MS);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Cycle social handles
  React.useEffect(() => {
    setSocialIndex(0);
    socialIndexRef.current = 0;

    if (socialHandles.length <= 1) {
      return;
    }

    const timer = setInterval(() => {
      const next = (socialIndexRef.current + 1) % socialHandles.length;
      socialIndexRef.current = next;
      setSocialIndex(next);
    }, SOCIAL_INTERVAL_MS);

    return () => clearInterval(timer);
  }, [socialHandles]);

  if (!visible || !resolvedContent.text) {
    return null;
  }

  const scrolling = resolvedContent.useMarquee;
  const activeLabel = label ?? LABELS[labelIndex];

  return (
    <div className={`toni-chyron ${visible ? 'toni-chyron-visible' : ''}`}>
      <div className='toni-chyron-slug'>
        <span className={`toni-chyron-slug-text${labelFading ? ' toni-chyron-slug-text--fading' : ''}`}>{activeLabel}</span>
      </div>
      <div className='toni-chyron-divider' aria-hidden='true' />
      <div className='toni-chyron-content'>
        <div className={`toni-chyron-text ${isChanging ? 'is-changing' : ''} ${scrolling ? 'marquee' : ''}`}>{displayText}</div>
        {socialHandles.length > 0 ? (
          <div className='toni-chyron-social-stack'>
            {socialHandles.map((handle, i) => (
              <div key={`${handle}-${i}`} className={`toni-chyron-social${i === socialIndex ? ' toni-chyron-social--active' : ''}`}>
                {handle}
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
};

// Legacy alias to avoid breaking existing imports while exposing the FifthBell rebrand.
export const ToniChyron = FifthBellChyron;
