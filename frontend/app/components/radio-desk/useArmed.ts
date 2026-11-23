import { useCallback, useEffect, useRef, useState } from "react";

/** How long an armed cue waits for the take before it clears itself. */
export const ARM_TIMEOUT_MS = 5_000;

/**
 * Arm-then-take: `arm(value)` holds a value for `timeoutMs`, after which it disarms itself; `take()`
 * returns the armed value and clears it, or null when nothing is armed. One call never takes: a
 * value has to be armed first.
 */
export function useArmed<T>(timeoutMs: number = ARM_TIMEOUT_MS) {
  const [armed, setArmed] = useState<T | null>(null);
  const armedRef = useRef<T | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clear = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    armedRef.current = null;
    setArmed(null);
  }, []);

  const arm = useCallback(
    (value: T) => {
      if (timer.current) clearTimeout(timer.current);
      armedRef.current = value;
      setArmed(value);
      timer.current = setTimeout(clear, timeoutMs);
    },
    [clear, timeoutMs],
  );

  const take = useCallback((): T | null => {
    const value = armedRef.current;
    clear();
    return value;
  }, [clear]);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  return { armed, arm, take, disarm: clear };
}
