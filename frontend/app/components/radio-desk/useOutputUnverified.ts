import { useEffect, useState } from "react";
import { isOutputSampleUnverified } from "./outputFreshness";

/**
 * Whether audible output has gone without a fresh sample. Freshness is re-read every second, so an output whose
 * samples stop goes unverified without a new answer (gaulatti/alcantara#706). Use it only in a small component:
 * that component renders again on every tick.
 */
export function useOutputUnverified(output: { state: string; lastSampleAt: string | null } | null): boolean {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, []);
  return isOutputSampleUnverified(output, now);
}
