import { useCallback } from 'react';
import { RelojClone as BleeckerRelojClone } from '@gaulatti/bleecker/components/reloj-clone';
import type { GlobalTimeOverride } from '../utils/broadcastTime';
import { getOverrideClockParts } from '../utils/broadcastTime';

interface RelojCloneProps {
  timezone?: string;
  /** The station's logo under the clock, from the scene; none is drawn when it is not given. */
  logoUrl?: string;
  timeOverride?: GlobalTimeOverride | null;
}

/** The Reloj clock on the broadcast: Bleecker draws it, and the console's broadcast time sets its hands. */
export default function RelojClone({ timezone = 'America/Argentina/Buenos_Aires', logoUrl, timeOverride = null }: RelojCloneProps) {
  const resolveTimeParts = useCallback(
    (now: Date) => (timeOverride ? getOverrideClockParts(timeOverride, now) : null),
    [timeOverride],
  );
  return <BleeckerRelojClone timezone={timezone} logoUrl={logoUrl} resolveTimeParts={resolveTimeParts} />;
}
