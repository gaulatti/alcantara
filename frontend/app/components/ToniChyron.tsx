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
const SOCIALS = ['@modoitaliano.oficial', '@fifth.bell', '@hnmages'];
const SOCIAL_INTERVAL_MS = 4000;

interface ToniChyronProps {
  text?: string;
  show?: boolean;
  useMarquee?: boolean;
  label?: string;
  contentMode?: 'text' | 'sequence';
  sequence?: unknown;
}

export const ToniChyron: React.FC<ToniChyronProps> = ({
  text = '',
  show = false,
  useMarquee,
  label,
  contentMode,
  sequence
}) => {
  const [visible, setVisible] = React.useState(show);
  const [nowMs, setNowMs] = React.useState(() => Date.now());
  const normalizedSequence = normalizeToniChyronSequence(sequence);
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
    const timer = setInterval(() => {
      const next = (socialIndexRef.current + 1) % SOCIALS.length;
      socialIndexRef.current = next;
      setSocialIndex(next);
    }, SOCIAL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, []);

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
        <div className='toni-chyron-social-stack'>
          {SOCIALS.map((handle, i) => (
            <div key={handle} className={`toni-chyron-social${i === socialIndex ? ' toni-chyron-social--active' : ''}`}>
              {handle}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
