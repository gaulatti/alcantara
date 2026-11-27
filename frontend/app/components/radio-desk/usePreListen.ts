import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Pre-fade listen for one file on this device (gaulatti/alcantara#835): it plays in the operator's browser and sends
 * nothing anywhere, so air, the mixer and other operators are untouched. One at a time; the same source again, Esc,
 * the file's end or leaving the desk stops it. `onActive` lets the program monitor mute while it is on.
 */
export function usePreListen(onActive?: (active: boolean) => void) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const notify = useRef(onActive);
  notify.current = onActive;
  const [playing, setPlaying] = useState<{ id: number; name: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const stop = useCallback(() => {
    audioRef.current?.pause();
    audioRef.current = null;
    notify.current?.(false);
    setPlaying(null);
  }, []);

  const toggle = useCallback(
    (source: { id: number; name: string; audioUrl: string }) => {
      const same = playing?.id === source.id;
      stop();
      setError(null);
      if (same) return;
      const audio = new Audio(source.audioUrl);
      audioRef.current = audio;
      // Only the file still being listened to can end or fail the pre-listen.
      const finish = (failure: string | null) => {
        if (audioRef.current !== audio) return;
        stop();
        setError(failure);
      };
      const failed = () => finish(`${source.name} could not be played here.`);
      audio.onended = () => finish(null);
      audio.onerror = failed;
      notify.current?.(true);
      setPlaying({ id: source.id, name: source.name });
      void Promise.resolve(audio.play()).catch(failed);
    },
    [playing, stop],
  );

  useEffect(() => {
    if (!playing) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") stop();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [playing, stop]);

  useEffect(() => stop, [stop]);

  return { playing, error, toggle, stop };
}
