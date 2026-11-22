import { Slider } from "@gaulatti/bleecker";
import { Button } from "./BleeckerButtons";
import { Headphones, Square } from "lucide-react";
import { useEffect, useRef } from "react";
import {
  useRadioListener,
  useRadioMonitor,
  type RadioListener,
} from "./RadioMonitor";

/** The listener controls over one listener: the audio element itself lives with whoever owns it. */
function RadioListenerView({
  listener,
  focusOnHash,
  audio,
}: {
  listener: RadioListener;
  focusOnHash: unknown;
  audio?: boolean;
}) {
  const monitorRef = useRef<HTMLDivElement>(null);
  const { state, error, volume, monitorUrl, preparing, programId } = listener;

  useEffect(() => {
    if (window.location.hash === "#radio-monitor") monitorRef.current?.focus();
  }, [focusOnHash]);

  return (
    <div
      id="radio-monitor"
      ref={monitorRef}
      tabIndex={-1}
      className="radio-output-monitor mt-3 space-y-2 border-t border-sand/20 pt-3"
      aria-label="Listener audio monitor"
    >
      {audio ? <audio {...listener.audioProps} /> : null}
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
          onClick={() =>
            state === "stopped" ? void listener.listen() : listener.stop()
          }
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
            onClick={listener.retryConnection}
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
            onChange={listener.setVolume}
          />
        </div>
      </div>
      <p className="text-xs text-text-secondary">
        Delayed audio · This device only
      </p>
    </div>
  );
}

/** A player with its own audio element: fixtures with an exact listener URL, or no shared monitor. */
function StandaloneRadioPlayer({
  listenerUrl,
  programId,
}: {
  listenerUrl?: string;
  programId?: string;
}) {
  const listener = useRadioListener({ listenerUrl, programId });
  return (
    <RadioListenerView
      listener={listener}
      focusOnHash={programId}
      audio
    />
  );
}

/** A view of the console's shared listener: the audio keeps playing when this page is left. */
function SharedRadioPlayer({
  monitor,
  programId,
}: {
  monitor: NonNullable<ReturnType<typeof useRadioMonitor>>;
  programId: string;
}) {
  const { attachPlayer } = monitor;
  useEffect(() => attachPlayer(), [attachPlayer]);
  return <RadioListenerView listener={monitor} focusOnHash={programId} />;
}

/** Listener-side audio only. This component never issues a playout command. */
export function RadioOutputPlayer({
  listenerUrl,
  programId,
}: {
  listenerUrl?: string;
  programId?: string;
}) {
  const monitor = useRadioMonitor();
  if (monitor && programId && !listenerUrl) {
    return <SharedRadioPlayer monitor={monitor} programId={programId} />;
  }
  return <StandaloneRadioPlayer listenerUrl={listenerUrl} programId={programId} />;
}
