import { useCallback, useEffect, useRef, useState } from "react";

export interface PreviewSong {
  id: number;
  audioUrl: string;
}

/**
 * One local preview player for a list of songs: an HTMLAudioElement in this browser and nothing else.
 * It never sends a playout command, reads no radio state and never touches the program's audio
 * path, so a preview cannot go on air. Leaving the page stops it.
 */
export function useSongPreview() {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [currentId, setCurrentId] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [length, setLength] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const element = useCallback(() => {
    if (!audioRef.current) {
      const audio = new Audio();
      audio.preload = "none";
      audio.addEventListener("play", () => setPlaying(true));
      audio.addEventListener("pause", () => setPlaying(false));
      audio.addEventListener("ended", () => setPlaying(false));
      audio.addEventListener("timeupdate", () => setPosition(audio.currentTime));
      audio.addEventListener("loadedmetadata", () =>
        setLength(Number.isFinite(audio.duration) ? audio.duration : null),
      );
      audio.addEventListener("error", () => {
        setPlaying(false);
        if (audio.getAttribute("src"))
          setError("This song cannot be previewed in the browser.");
      });
      audioRef.current = audio;
    }
    return audioRef.current;
  }, []);

  useEffect(
    () => () => {
      const audio = audioRef.current;
      if (audio && !audio.paused) audio.pause();
    },
    [],
  );

  const load = useCallback(
    (song: PreviewSong | null) => {
      const audio = element();
      if (!audio.paused) audio.pause();
      setCurrentId(song?.id ?? null);
      setPosition(0);
      setLength(null);
      setError(null);
      setPlaying(false);
      if (song) audio.src = song.audioUrl;
      else audio.removeAttribute("src");
    },
    [element],
  );

  const toggle = useCallback(
    (song: PreviewSong) => {
      const audio = element();
      if (song.id !== currentId || !audio.getAttribute("src")) load(song);
      if (audio.paused) {
        setError(null);
        void Promise.resolve(audio.play()).catch(() => {
          setPlaying(false);
          setError("This song cannot be previewed in the browser.");
        });
      } else {
        audio.pause();
      }
    },
    [currentId, element, load],
  );

  const seek = useCallback(
    (seconds: number) => {
      const audio = element();
      audio.currentTime = seconds;
      setPosition(seconds);
    },
    [element],
  );

  return { currentId, playing, position, length, error, load, toggle, seek };
}
