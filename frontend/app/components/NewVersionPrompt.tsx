import { Button } from "@gaulatti/bleecker";
import { RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { authFetch } from "../services/api";
import { deployedBuild, runningBuild } from "../utils/buildVersion";
import { useHostMic } from "./HostMicOnAir";

/** How often an open console asks which build is deployed. */
export const BUILD_CHECK_MS = 60_000;

/**
 * Whether a guest of the show is live right now: cued live and connected. Read only once a new build is waiting, so a
 * console that is current never asks. A read that fails counts as live, so the prompt waits rather than interrupt.
 */
async function guestLive(programId: string): Promise<boolean> {
  try {
    const response = await authFetch(`/webrtc/rooms/${encodeURIComponent(programId)}/participants`);
    if (!response.ok) return response.status !== 403 && response.status !== 503;
    const body = (await response.json()) as { participants?: Array<{ connectionState?: string; cueState?: string | null }> };
    return (body.participants ?? []).some((guest) => guest.connectionState === "connected" && guest.cueState === "live");
  } catch {
    return true;
  }
}

/**
 * "New version · Reload" on an open console once the deployed build changes (gaulatti/alcantara#879). It never
 * reloads by itself and blocks nothing. It is held back while the host microphone is open, or a guest of the show is
 * live, and appears once they are not, so a reload can never cut someone off air.
 */
export function NewVersionPrompt({ programId, check = BUILD_CHECK_MS }: { programId: string; check?: number }) {
  const hostMic = useHostMic();
  const micOpen = hostMic !== null && hostMic.state !== "off";
  const [waiting, setWaiting] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [guestOnAir, setGuestOnAir] = useState(false);
  const running = useRef(runningBuild());

  const look = useCallback(async () => {
    if (!running.current) return;
    const deployed = await deployedBuild();
    if (!deployed || deployed === running.current) return;
    setWaiting(deployed);
    setGuestOnAir(await guestLive(programId));
  }, [programId]);

  useEffect(() => {
    const timer = window.setInterval(() => void look(), check);
    const onVisible = () => {
      if (document.visibilityState === "visible") void look();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [check, look]);

  if (!waiting || waiting === dismissed || micOpen || guestOnAir) return null;
  return (
    <span role="status" className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-sand/40 py-0.5 pl-2.5 pr-1 text-xs font-semibold">
      <RefreshCw size={14} aria-hidden="true" />
      <span>New version</span>
      <Button size="xs" variant="secondary" onClick={() => window.location.reload()}>
        Reload
      </Button>
      <Button size="xs" variant="ghost" onClick={() => setDismissed(waiting)} aria-label="Not now: keep this version until the next one">
        Later
      </Button>
    </span>
  );
}
