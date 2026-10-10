import { Button, Slider } from "@gaulatti/bleecker";
import { Headphones, Square } from "lucide-react";
import { useEffect, useRef, useState } from "react";

/** Listener-side audio only. This component never issues a playout command. */
export function RadioOutputPlayer({ listenerUrl }: { listenerUrl: string }) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const request = useRef(0);
  const [state, setState] = useState<"stopped" | "buffering" | "playing">(
    "stopped",
  );
  const [error, setError] = useState<string | null>(null);
  const [volume, setVolume] = useState(1);

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
  }, [listenerUrl]);

  const listen = async () => {
    const audio = audioRef.current;
    if (!audio) return;
    const current = ++request.current;
    setError(null);
    setState("buffering");
    audio.src = listenerUrl;
    audio.volume = volume;
    try {
      await audio.play();
      if (request.current === current) setState("playing");
    } catch {
      if (request.current !== current) return;
      stop();
      setError(
        "Broadcast audio could not be played. Check the listener URL and try again.",
      );
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
          setError(
            "The listener stream is unavailable. Check the listener URL and try again.",
          );
        }}
      />
      <p role="status">
        {state === "playing"
          ? "Listening to broadcast"
          : state === "buffering"
            ? "Connecting to broadcast…"
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
          onClick={() => (state === "stopped" ? void listen() : stop())}
          title={
            state === "stopped"
              ? "Listen to the station's published audio stream"
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
        Listener stream delay applies. Monitor volume and Stop listening affect
        only this device.
      </p>
    </div>
  );
}
