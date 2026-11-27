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

export function HeadphonesToggle() {
  const checked = usePreFadeOnHeadphones();
  return (
    <label className="inline-flex min-h-11 items-center gap-1.5 text-xs text-text-secondary" title="While your mic is live, pre-listens and previews are muted unless you are on headphones. This device remembers.">
      <input type="checkbox" checked={checked} onChange={(event) => setOnHeadphones(event.target.checked)} />
      I'm on headphones: keep pre-fade
    </label>
  );
}
