import { useEffect, useState } from "react";
import { authFetch } from "../services/api";
import { callHealthWarning, type CallHealthWarning } from "../utils/callHealth";

/** How often the call chain is asked after. */
export const CALL_HEALTH_REFRESH_MS = 10_000;

/** One line while part of the call chain is down; nothing at all otherwise. */
export function CallHealthBanner({ programId, className = "" }: { programId: string; className?: string }) {
  const [read, setRead] = useState<{ programId: string; warning: CallHealthWarning | null } | null>(null);

  useEffect(() => {
    let current = true;
    const load = async () => {
      let warning: CallHealthWarning | null = null;
      try {
        const response = await authFetch(`/webrtc/health?programId=${encodeURIComponent(programId)}`);
        // Not there yet (404), refused or failing: unknown, which is not said.
        if (response.ok) warning = callHealthWarning(await response.json());
      } catch {
        // Unknown too.
      }
      if (current) setRead({ programId, warning });
    };
    void load();
    const timer = window.setInterval(() => void load(), CALL_HEALTH_REFRESH_MS);
    return () => {
      current = false;
      window.clearInterval(timer);
    };
  }, [programId]);

  // Another show's answer is never shown for this one.
  const warning = read?.programId === programId ? read.warning : null;
  if (!warning) return null;
  return (
    <p role="status" data-testid="call-health" className={`border-l-4 border-amber-400 bg-amber-400/10 px-3 py-1.5 text-sm text-text-primary ${className}`}>
      <strong className="font-semibold">{warning.problem}.</strong> {warning.action}
    </p>
  );
}
