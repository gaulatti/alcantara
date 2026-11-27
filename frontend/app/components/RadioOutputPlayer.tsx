import { Slider } from "@gaulatti/bleecker";
import { Button } from "./BleeckerButtons";
import { Headphones, Square } from "lucide-react";
import { KeyCap } from "./radio-desk/primitives";
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
  micLive = false,
  variant = "panel",
}: {
  /** The monitor is muted because the host microphone is open. */
  micLive?: boolean;
  listener: RadioListener;
  focusOnHash: unknown;
  audio?: boolean;
  /** "transport": the radio desk's one listen control, one row in its transport (Listen with its key and volume). */
  variant?: "panel" | "transport";
}) {
  const monitorRef = useRef<HTMLDivElement>(null);
  const { state, error, volume, monitorUrl, preparing, programId } = listener;

  useEffect(() => {
    if (window.location.hash === "#radio-monitor") monitorRef.current?.focus();
  }, [focusOnHash]);

  if (variant === "transport") {
    const listening = state !== "stopped";
    return (
      <div
        id="radio-monitor"
        ref={monitorRef}
        tabIndex={-1}
        className="desk-monitor"
        role="group"
        aria-label="Listener audio monitor"
      >
        {audio ? <audio {...listener.audioProps} /> : null}
        <button
          type="button"
          className="desk-key"
          aria-pressed={listening}
          data-active={listening ? "true" : undefined}
          disabled={state === "stopped" && !!programId && !monitorUrl}
          onClick={() => (state === "stopped" ? void listener.listen() : listener.stop())}
          title={
            state === "stopped"
              ? "Listen to the station broadcast on this device (delayed, this device only)"
              : "Stop listening on this device; broadcasting continues"
          }
        >
          <Headphones size={15} aria-hidden="true" />
          {/* A toggle key: its legend stays Listen, and its pressed state (lit) says it is on, as a hardware key. */}
          Listen <KeyCap>M</KeyCap>
        </button>
        <div className="desk-monitor-volume">
          <Slider
            aria-label="Monitor volume"
            min={0}
            max={1}
            step={0.01}
            value={volume}
            onChange={listener.setVolume}
          />
        </div>
        <span role="status" className="desk-monitor-state">
          {micLive
            ? "Muted · mic live"
            : state === "playing"
              ? "Listening"
              : state === "buffering" || preparing
                ? "Connecting"
                : ""}
        </span>
        {error ? (
          <span role="alert" className="desk-fault-text">
            {error}
          </span>
        ) : null}
        {programId && error && state === "stopped" && !monitorUrl ? (
          <button type="button" className="desk-key" onClick={listener.retryConnection}>
            Retry
          </button>
        ) : null}
      </div>
    );
  }

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
        {micLive
          ? "Muted while your mic is live"
          : state === "playing"
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
  variant,
}: {
  listenerUrl?: string;
  programId?: string;
  variant?: "panel" | "transport";
}) {
  const listener = useRadioListener({ listenerUrl, programId });
  return (
    <RadioListenerView
      listener={listener}
      focusOnHash={programId}
      audio
      variant={variant}
    />
  );
}

/** A view of the console's shared listener: the audio keeps playing when this page is left. */
function SharedRadioPlayer({
  monitor,
  programId,
  variant,
}: {
  monitor: NonNullable<ReturnType<typeof useRadioMonitor>>;
  programId: string;
  variant?: "panel" | "transport";
}) {
  const { attachPlayer } = monitor;
  useEffect(() => attachPlayer(), [attachPlayer]);
  return <RadioListenerView listener={monitor} focusOnHash={programId} micLive={monitor.micLive} variant={variant} />;
}

/** Listener-side audio only. This component never issues a playout command. */
export function RadioOutputPlayer({
  listenerUrl,
  programId,
  variant,
}: {
  listenerUrl?: string;
  programId?: string;
  /** "transport": the radio desk's one listen control, inline in its transport. */
  variant?: "panel" | "transport";
}) {
  const monitor = useRadioMonitor();
  if (monitor && programId && !listenerUrl) {
    return <SharedRadioPlayer monitor={monitor} programId={programId} variant={variant} />;
  }
  return <StandaloneRadioPlayer listenerUrl={listenerUrl} programId={programId} variant={variant} />;
}
