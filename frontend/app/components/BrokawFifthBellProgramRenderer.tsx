import React, { Suspense, lazy, type ComponentType } from 'react';
// The current local renderer: the fallback until the closer deletes it (gaulatti/alcantara#381).
import LocalFifthBellProgram, { type FifthBellProgramProps } from '../programs/fifthbell/FifthBellProgram';
import { getApiBaseUrl } from '../utils/apiBaseUrl';

type BrokawLiveProgramProps = FifthBellProgramProps & { apiBaseUrl?: string };

/**
 * Brokaw's Fifth Bell program (`LiveProgram` from `@fifthbell/brokaw/components/live-program`)
 * when the pinned Brokaw exports it by name (0.1.80 and later: the version that takes
 * `masterGain`), otherwise the local renderer. Like Giorgia's artist bumper, the package owns
 * the presentation and Alcántara only places it; the package loads only when it is on screen.
 * Brokaw reads the program from Alcántara's API itself, so it gets this API's origin.
 * The closer bumps the pin and deletes the local renderer and this fallback.
 */
const FifthBellProgram = lazy(async (): Promise<{ default: ComponentType<FifthBellProgramProps> }> => {
  const module = (await import('@fifthbell/brokaw/components/live-program')) as Record<string, unknown>;
  const Packaged = ('LiveProgram' in module ? module.LiveProgram : undefined) as ComponentType<BrokawLiveProgramProps> | undefined;
  if (!Packaged) return { default: LocalFifthBellProgram };
  const apiBaseUrl = getApiBaseUrl();
  return { default: (props: FifthBellProgramProps) => <Packaged {...props} apiBaseUrl={apiBaseUrl} /> };
});

export default function BrokawFifthBellProgramRenderer(props: FifthBellProgramProps) {
  return (
    <Suspense fallback={null}>
      <FifthBellProgram {...props} />
    </Suspense>
  );
}
