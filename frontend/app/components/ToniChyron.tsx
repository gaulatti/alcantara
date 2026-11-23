import React, { useEffect, useState } from 'react';
import { FifthBellChyron as BrokawFifthBellChyron } from '@fifthbell/brokaw/components/toni';
import { getToniChyronContentMode, normalizeToniChyronSequence, resolveToniChyronContent } from '../utils/toniChyronSequence';

interface FifthBellChyronProps {
  text?: string;
  show?: boolean;
  useMarquee?: boolean;
  label?: string;
  contentMode?: 'text' | 'sequence';
  sequence?: unknown;
  socialHandles?: unknown;
}

/** The handles the producer configured: strings only, trimmed, and none that are blank. */
function configuredHandles(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((entry): entry is string => typeof entry === 'string').map((entry) => entry.trim()).filter((entry) => entry.length > 0);
}

/**
 * The Fifth Bell chyron is Brokaw's. The app keeps the chyron's sequence model: it resolves the text for
 * the current moment, every half second while a sequence is playing, and hands Brokaw the result.
 */
export const FifthBellChyron: React.FC<FifthBellChyronProps> = ({ text = '', show = false, useMarquee, label, contentMode, sequence, socialHandles }) => {
  const [nowMs, setNowMs] = useState(() => Date.now());
  const normalizedSequence = normalizeToniChyronSequence(sequence);
  const isSequenceMode = getToniChyronContentMode(contentMode, normalizedSequence) === 'sequence';

  useEffect(() => {
    if (!isSequenceMode || !normalizedSequence) return;
    const timer = setInterval(() => setNowMs(Date.now()), 500);
    return () => clearInterval(timer);
  }, [isSequenceMode, sequence]);

  const resolved = resolveToniChyronContent({ text, useMarquee, contentMode, sequence: normalizedSequence }, nowMs);
  return (
    <BrokawFifthBellChyron
      text={resolved.text}
      show={show}
      useMarquee={resolved.useMarquee}
      label={label}
      socialHandles={configuredHandles(socialHandles)}
    />
  );
};

// Legacy alias to avoid breaking existing imports while exposing the FifthBell rebrand.
export const ToniChyron = FifthBellChyron;
