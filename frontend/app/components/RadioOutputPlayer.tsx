import { Button, Slider } from "@gaulatti/bleecker";
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

  // Prepare a short-lived native-audio grant before the click, preserving Safari's
  // user gesture for play(). Refresh only while stopped; never interrupt audio.
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
          typeof grant.streamPath !== "string" ||
          !grant.streamPath.startsWith(
            `/radio/${encodeURIComponent(programId)}/monitor-audio?ticket=`,
          )
        )
          throw new Error();
        if (abort.signal.aborted) return;
        setMonitorUrl(apiUrl(grant.streamPath));
        timer = setTimeout(() => void prepare(), 10_000);
      } catch {
        if (!abort.signal.aborted)
          setError("The Program monitor could not connect. Retry connection.");
      } finally {
        if (!abort.signal.aborted) setPreparing(false);
      }
    };
    void prepare();
    return () => {
      abort.abort();
      clearTimeout(timer);
    };
  }, [programId, state, retry]);

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
    <div className="space-y-4" aria-label="Listener audio monitor">
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
      <p role="status">
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
      <div className="flex flex-wrap items-center gap-6">
        <Button
          type="button"
          disabled={state === "stopped" && !!programId && !monitorUrl}
          onClick={() => (state === "stopped" ? void listen() : stop())}
          title={
            state === "stopped"
              ? "Listen to Palazzo's Icecast output through Alcántara"
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
            onClick={() => {
              setError(null);
              setRetry((value) => value + 1);
            }}
          >
            Retry connection
          </Button>
        )}
        <div className="w-52 max-w-full">
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
      <p className="text-sm text-text-secondary">
        Icecast buffering applies. Monitor volume and Stop listening affect only
        this device.
      </p>
    </div>
  );
}
