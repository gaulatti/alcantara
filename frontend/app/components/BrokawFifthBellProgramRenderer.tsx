import React, { Suspense, lazy } from 'react';
import { getApiBaseUrl } from '../utils/apiBaseUrl';

/** The props the Fifth Bell scene components pass (gaulatti/alcantara#381). */
export interface FifthBellProgramProps {
  programId?: string;
  embedded?: boolean;
  sceneMetadata?: Record<string, unknown> | null;
  activeComponents?: string[];
  masterGain?: number;
}

/**
 * The Fifth Bell program is Brokaw's: `LiveProgram` from `@fifthbell/brokaw/components/live-program`,
 * placed here like Giorgia's artist bumper. Brokaw reads the program from this API and loads its
 * images and pipes cue from `/fifthbell`, which Alcántara serves (public/fifthbell). The package
 * loads only when the program is on screen.
 */
const LiveProgram = lazy(async () => ({ default: (await import('@fifthbell/brokaw/components/live-program')).LiveProgram }));

export default function BrokawFifthBellProgramRenderer(props: FifthBellProgramProps) {
  return (
    <Suspense fallback={null}>
      <LiveProgram {...props} apiBaseUrl={getApiBaseUrl()} assetBaseUrl='/fifthbell' />
    </Suspense>
  );
}
