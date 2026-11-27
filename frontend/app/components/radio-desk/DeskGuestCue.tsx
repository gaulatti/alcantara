import { Button } from "@gaulatti/bleecker";
import { useState } from "react";
import { useFeatures } from "../../hooks/useFeatures";
import { authFetch } from "../../services/api";
import { currentCue, type Cue, type CueState } from "../../utils/callerDesk";
import { GuestCueButtons, useGuestCue } from "../GuestCueControls";
import type { DeskGuest } from "./guestChip";

/** The API's own reason for a refusal, or its status. */
async function refusal(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  try {
    const parsed = JSON.parse(text) as { message?: unknown };
    if (typeof parsed.message === "string" && parsed.message) return parsed.message;
  } catch {
    // Not JSON: the text, or the status, below.
  }
  return text || `Request failed (${response.status})`;
}

/**
 * Admit and the cues for one guest, on the radio desk (gaulatti/alcantara#879): the operator lets a waiting guest in,
 * cues them live or stands them by, and wraps them, without leaving the desk. The controls are the Guest calls ones
 * (a double press for Cue live, a hold for Wrap) and send the same commands.
 */
export function DeskGuestCue({
  guest,
  programId,
  onChanged,
}: {
  guest: DeskGuest;
  programId: string;
  /** Read the guest list again after a command, so the desk shows its effect at once. */
  onChanged: () => void;
}) {
  const { hasPermission, loading } = useFeatures();
  const canOperate = !loading && hasPermission("alcantara:webrtc:operate");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The cue the last command set, until the next read of the list says otherwise.
  const [sent, setSent] = useState<{ cue: CueState; from: CueState | null } | null>(null);
  const stored = currentCue(guest);
  const cue = sent && sent.from === stored ? sent.cue : stored;

  const run = async (action: () => Promise<Response>, after?: () => void) => {
    setBusy(true);
    setError(null);
    try {
      const response = await action();
      if (!response.ok) throw new Error(await refusal(response));
      after?.();
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The studio did not take that.");
    } finally {
      setBusy(false);
    }
  };

  const controls = useGuestCue((next: Cue) => {
    void run(
      () =>
        authFetch(`/webrtc/rooms/${encodeURIComponent(programId)}/participants/${encodeURIComponent(guest.identity)}/control`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "cue", cue: next }),
        }),
      () => setSent({ cue: next, from: stored }),
    );
  });

  if (guest.screening) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-text-secondary">Waiting to be let in</span>
        <Button
          size="xs"
          variant="secondary"
          disabled={!canOperate || busy || !guest.invitationId}
          onClick={() => void run(() => authFetch(`/webrtc/invitations/${encodeURIComponent(guest.invitationId!)}/admit`, { method: "POST" }))}
        >
          Admit {guest.name}
        </Button>
        {error ? (
          <p role="alert" className="w-full text-[10px] text-accent-yellow">
            {error}
          </p>
        ) : null}
      </div>
    );
  }

  return (
    // No Space here: on the desk Space is the transport's Take, so the live cue is sent by the second press only.
    <div role="group" aria-label={`Cue ${guest.name}`}>
      <GuestCueButtons
        cue={cue}
        disabled={!canOperate || busy || guest.connectionState !== "connected"}
        controls={controls}
        spaceSendsLive={false}
      />
      {error ? (
        <p role="alert" className="text-[10px] text-accent-yellow">
          {error}
        </p>
      ) : null}
    </div>
  );
}
