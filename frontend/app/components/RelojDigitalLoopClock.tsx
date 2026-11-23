import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { RelojDigitalLoopClock as BrokawRelojDigitalLoopClock } from '@gaulatti/bleecker/components/reloj-digital-loop-clock';
import { normalizeProgramTextSequence, resolveProgramTextLeaf } from '../utils/programSequence';
import { completeSceneCountdown } from '../services/program';
import { GiorgiaMark } from '@modoitaliano/giorgia/scenes';

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
  allowProgramActivation?: boolean;
}

/**
 * The Reloj digital clock is Bleecker's. The app keeps what is program-specific: it resolves the title and
 * call-to-action sequences, supplies the Giorgia mark, and switches the program when the countdown reaches zero.
 */
export default function RelojDigitalLoopClock({
  timezone,
  textSequence,
  ctaSequence,
  programId,
  mode = 'clock',
  countdownDuration = 300,
  countdownTargetSceneId,
  countdownCommand,
  allowProgramActivation = true,
}: RelojDigitalLoopClockProps) {
  const normalizedTextSequence = useMemo(() => normalizeProgramTextSequence(textSequence), [textSequence]);
  const normalizedCtaSequence = useMemo(() => normalizeProgramTextSequence(ctaSequence), [ctaSequence]);
  const shouldTick = normalizedTextSequence?.mode === 'autoplay' || normalizedCtaSequence?.mode === 'autoplay';
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    if (!shouldTick) return;
    const timer = window.setInterval(() => setNowMs(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [shouldTick, normalizedTextSequence?.mode, normalizedCtaSequence?.mode]);

  const titleText = resolveProgramTextLeaf({ contentMode: 'sequence', sequence: normalizedTextSequence }, nowMs)?.text?.trim() || '';
  const ctaText = resolveProgramTextLeaf({ contentMode: 'sequence', sequence: normalizedCtaSequence }, nowMs)?.text?.trim() || '';

  const onCountdownComplete = useCallback(() => {
    if (allowProgramActivation && programId && countdownTargetSceneId) {
      // The on-air page is not signed in, so it cannot take a scene itself. The API takes the target
      // from the scene's own settings.
      completeSceneCountdown(programId).catch((error) => {
        console.error('The countdown reached zero but the scene did not switch:', error);
      });
    }
  }, [allowProgramActivation, programId, countdownTargetSceneId]);

  return (
    <BrokawRelojDigitalLoopClock
      timezone={timezone}
      titleText={titleText}
      ctaText={ctaText}
      mode={mode}
      countdownDuration={countdownDuration}
      countdownCommand={countdownCommand}
      onCountdownComplete={onCountdownComplete}
      brandMark={<GiorgiaMark width={172} />}
    />
  );
}
