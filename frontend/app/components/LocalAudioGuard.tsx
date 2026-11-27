import { useEffect, useSyncExternalStore } from "react";
import { onHeadphones, preFadeMuted, setHostMicLive, setOnHeadphones, subscribeLocalAudio } from "../utils/localAudio";
import { useHostMic } from "./HostMicOnAir";

/** Tells the local audio when the console's microphone is open, from the press until it is off. */
export function LocalAudioGuard() {
  const mic = useHostMic();
  const live = mic !== null && mic.state !== "off";
  useEffect(() => {
    setHostMicLive(live);
    return () => setHostMicLive(false);
  }, [live]);
  return null;
}

export const usePreFadeOnHeadphones = () => useSyncExternalStore(subscribeLocalAudio, onHeadphones, () => false);
export const usePreFadeMuted = () => useSyncExternalStore(subscribeLocalAudio, preFadeMuted, () => false);

/** The desk's terse toggle; with a label (the calls status bar) it reads as that label instead. */
export function HeadphonesToggle({ label }: { label?: string } = {}) {
  const checked = usePreFadeOnHeadphones();
  if (label !== undefined)
    return (
      <label className="inline-flex min-h-11 items-center gap-1.5 text-xs text-text-secondary" title="While your mic is live, pre-listens and previews are muted unless you are on headphones. This device remembers.">
        <input type="checkbox" checked={checked} onChange={(event) => setOnHeadphones(event.target.checked)} />
        {label}
      </label>
    );
  return (
    // Terse on the desk; the full meaning is its accessible name and its hover title.
    <label className="desk-toggle" title="I'm on headphones: keep pre-fade. While your mic is live, pre-listens and previews are muted unless you are on headphones. This device remembers.">
      <input
        type="checkbox"
        aria-label="I'm on headphones: keep pre-fade"
        checked={checked}
        onChange={(event) => setOnHeadphones(event.target.checked)}
      />
      Phones PFL
    </label>
  );
}
