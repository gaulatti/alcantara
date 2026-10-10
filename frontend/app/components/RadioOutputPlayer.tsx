import { Slider } from "@gaulatti/bleecker";
import { Button } from "./BleeckerButtons";
import { Headphones, Square } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { apiUrl } from "../utils/apiBaseUrl";

/** Listener-side audio only. This component never issues a playout command. */
export function RadioOutputPlayer({
  listenerUrl,
  programId,
}: {
  listenerUrl?: string;
  programId?: string;
}) {
  const monitorRef = useRef<HTMLDivElement>(null);
  const grantExpiresAt = useRef(0);
  const audioRef = useRef<HTMLAudioElement>(null);
  const request = useRef(0);
  const [state, setState] = useState<"stopped" | "buffering" | "playing">(
    "stopped",
  );
  const [error, setError] = useState<string | null>(null);
  const [volume, setVolume] = useState(1);
  const [monitorUrl, setMonitorUrl] = useState<string | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [retry, setRetry] = useState(0);

  // Prepare authorization before the click to keep play() inside Safari's user
  // gesture. Idle grants refresh from the producer's lifetime; active audio is
  // never replaced. Returning from a background tab refreshes an idle grant.
  useEffect(() => {
    if (!programId || state !== "stopped") return;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const prepare = async () => {
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
        timer = setTimeout(() => void prepare(), grant.expiresInMs - 5_000);
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
    void prepare();
    return () => {
      document.removeEventListener("visibilitychange", refreshOnReturn);
      abort.abort();
      clearTimeout(timer);
    };
  }, [programId, state, retry]);

  useEffect(() => {
    if (window.location.hash === "#radio-monitor") monitorRef.current?.focus();
  }, [programId]);

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

  return (
    <div
      id="radio-monitor"
      ref={monitorRef}
      tabIndex={-1}
      className="radio-output-monitor mt-3 space-y-2 border-t border-sand/20 pt-3"
      aria-label="Listener audio monitor"
    >
      <audio
        ref={audioRef}
        preload="none"
        onWaiting={() => {
          if (audioRef.current?.getAttribute("src")) setState("buffering");
        }}
        onPlaying={() => {
          if (audioRef.current?.getAttribute("src")) setState("playing");
        }}
        onEnded={stop}
        onError={() => {
          if (!audioRef.current?.getAttribute("src")) return;
          stop();
          setError("The listener stream is unavailable. Try listening again.");
        }}
      />
      <p role="status" className="text-xs text-text-secondary">
        {state === "playing"
          ? "Listening to broadcast"
          : state === "buffering"
            ? "Connecting to broadcast…"
            : preparing
              ? "Connecting to Program monitor…"
              : "Monitor stopped"}
      </p>
      {error && (
        <p role="alert" className="text-sm text-terracotta">
          {error}
        </p>
      )}
      <div className="flex flex-wrap items-end gap-3">
        <Button
          type="button"
          size="xs"
          disabled={state === "stopped" && !!programId && !monitorUrl}
          onClick={() => (state === "stopped" ? void listen() : stop())}
          title={
            state === "stopped"
              ? "Listen to the station broadcast on this device"
              : "Stop listening on this device; broadcasting continues"
          }
        >
          {state === "stopped" ? (
            <Headphones size={16} />
          ) : (
            <Square size={16} />
          )}
          {state === "stopped" ? "Listen" : "Stop listening"}
        </Button>
        {programId && error && state === "stopped" && !monitorUrl && (
          <Button
            type="button"
            variant="secondary"
            size="xs"
            onClick={() => {
              setError(null);
              setRetry((value) => value + 1);
            }}
          >
            Retry connection
          </Button>
        )}
        <div className="min-w-0 flex-1 basis-28">
          <Slider
            label="Monitor volume"
            aria-label="Monitor volume"
            min={0}
            max={1}
            step={0.01}
            value={volume}
            onChange={(next) => {
              setVolume(next);
              if (audioRef.current) audioRef.current.volume = next;
            }}
          />
        </div>
      </div>
      <p className="text-xs text-text-secondary">
        Delayed audio · This device only
      </p>
    </div>
  );
}
