import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { apiUrl } from "../utils/apiBaseUrl";

export type RadioMonitorState = "stopped" | "buffering" | "playing";

/**
 * Listener-side audio only: it never issues a playout command. One instance owns one audio element
 * for one source (a Program's monitor grant, or an exact listener URL for fixtures).
 *
 * The monitor grant is prepared only while `prepare` is true and the audio is stopped, so a page
 * that shows no player never asks for one. Prepared before the click to keep play() inside
 * Safari's user gesture. Idle grants refresh from the producer's lifetime; active audio is never
 * replaced. Returning from a background tab refreshes an idle grant.
 */
export function useRadioListener({
  listenerUrl,
  programId,
  prepare = true,
}: {
  listenerUrl?: string;
  programId?: string;
  prepare?: boolean;
}) {
  const grantExpiresAt = useRef(0);
  const audioRef = useRef<HTMLAudioElement>(null);
  const request = useRef(0);
  const [state, setState] = useState<RadioMonitorState>("stopped");
  const [error, setError] = useState<string | null>(null);
  const [volume, setVolumeState] = useState(1);
  const [monitorUrl, setMonitorUrl] = useState<string | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    if (!programId || !prepare || state !== "stopped") return;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const prepareGrant = async () => {
      setPreparing(true);
      setMonitorUrl(null);
      try {
        const response = await fetch(
          apiUrl(`/radio/${encodeURIComponent(programId)}/monitor-ticket`),
          { method: "POST", signal: abort.signal },
        );
        if (!response.ok) throw new Error();
        const grant = await response.json();
        if (
          !Number.isFinite(grant.expiresInMs) ||
          grant.expiresInMs < 5_000 ||
          typeof grant.streamPath !== "string" ||
          !grant.streamPath.startsWith(
            `/radio/${encodeURIComponent(programId)}/monitor-audio?ticket=`,
          )
        )
          throw new Error();
        if (abort.signal.aborted) return;
        grantExpiresAt.current = Date.now() + grant.expiresInMs;
        setMonitorUrl(apiUrl(grant.streamPath));
        timer = setTimeout(() => void prepareGrant(), grant.expiresInMs - 5_000);
      } catch {
        if (!abort.signal.aborted)
          setError("The Program monitor could not connect. Retry connection.");
      } finally {
        if (!abort.signal.aborted) setPreparing(false);
      }
    };
    const refreshOnReturn = () => {
      if (document.visibilityState !== "visible") return;
      clearTimeout(timer);
      setRetry((value) => value + 1);
    };
    document.addEventListener("visibilitychange", refreshOnReturn);
    void prepareGrant();
    return () => {
      document.removeEventListener("visibilitychange", refreshOnReturn);
      abort.abort();
      clearTimeout(timer);
    };
  }, [programId, prepare, state, retry]);

  const stop = () => {
    request.current += 1;
    const audio = audioRef.current;
    if (audio) {
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
    }
    setState("stopped");
  };
  useEffect(() => {
    const audio = audioRef.current;
    request.current += 1;
    setState("stopped");
    setError(null);
    return () => {
      request.current += 1;
      audio?.pause();
      audio?.removeAttribute("src");
      audio?.load();
    };
  }, [listenerUrl, programId]);

  const listen = async () => {
    const audio = audioRef.current;
    const source = programId ? monitorUrl : listenerUrl;
    if (!audio || !source) return;
    if (programId && Date.now() >= grantExpiresAt.current) {
      setMonitorUrl(null);
      setError(
        "Monitor connection expired. Preparing a new connection; press Listen when ready.",
      );
      setRetry((value) => value + 1);
      return;
    }
    const current = ++request.current;
    setError(null);
    setState("buffering");
    audio.src = source;
    audio.volume = volume;
    try {
      await audio.play();
      if (request.current === current) setState("playing");
    } catch {
      if (request.current !== current) return;
      stop();
      setError("Broadcast audio could not be played. Try listening again.");
    }
  };

  const setVolume = (next: number) => {
    setVolumeState(next);
    if (audioRef.current) audioRef.current.volume = next;
  };
  const retryConnection = () => {
    setError(null);
    setRetry((value) => value + 1);
  };

  const audioProps = {
    ref: audioRef,
    preload: "none" as const,
    onWaiting: () => {
      if (audioRef.current?.getAttribute("src")) setState("buffering");
    },
    onPlaying: () => {
      if (audioRef.current?.getAttribute("src")) setState("playing");
    },
    onEnded: stop,
    onError: () => {
      if (!audioRef.current?.getAttribute("src")) return;
      stop();
      setError("The listener stream is unavailable. Try listening again.");
    },
  };

  return {
    programId,
    state,
    error,
    volume,
    monitorUrl,
    preparing,
    audioProps,
    listen,
    stop,
    setVolume,
    retryConnection,
  };
}

export type RadioListener = ReturnType<typeof useRadioListener>;
type RadioMonitorValue = RadioListener & {
  /** Mutes the monitor while something is being pre-listened on this device (#835). */
  setPreListening: (active: boolean) => void;
  /** A player view calls this while it is on screen; the grant is prepared only then. */
  attachPlayer: () => () => void;
};

const RadioMonitorContext = createContext<RadioMonitorValue | null>(null);

/**
 * The console's one listener audio element, mounted in the persistent layout so it keeps playing
 * while the operator moves between console pages. Changing program or leaving the layout (sign-out)
 * stops it: the element is released by the same cleanup as a station change.
 */
export function RadioMonitorProvider({
  programId,
  children,
}: {
  programId: string;
  children: ReactNode;
}) {
  const [players, setPlayers] = useState(0);
  const listener = useRadioListener({ programId, prepare: players > 0 });
  const attachPlayer = useMemo(
    () => () => {
      setPlayers((count) => count + 1);
      return () => setPlayers((count) => Math.max(0, count - 1));
    },
    [],
  );
  const [preListening, setPreListening] = useState(false);
  const value = { ...listener, attachPlayer, setPreListening };
  return (
    <RadioMonitorContext.Provider value={value}>
      <audio {...listener.audioProps} muted={preListening} />
      {children}
    </RadioMonitorContext.Provider>
  );
}

/** The console's shared listener, or null outside the persistent layout (fixtures, tests). */
export function useRadioMonitor(): RadioMonitorValue | null {
  return useContext(RadioMonitorContext);
}
