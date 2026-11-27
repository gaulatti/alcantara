import { Button, Input, Select } from "@gaulatti/bleecker";
import {
  Headphones,
  Mic,
  MicOff,
  RefreshCw,
  Send,
  Trash2,
  Video,
  VideoOff,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  ARM_TIMEOUT_MS,
  HOLD_MS,
  STRIP_LABEL,
  latestCue,
  stripState,
  type Cue,
  type DeskCommand,
} from "../utils/callerDesk";

export type ReturnField =
  | "returnVideo"
  | "returnAudioBus"
  | "sourceGain"
  | "sourceMuted"
  | "sourceDelayMs";

export interface StripParticipant {
  identity: string;
  name: string;
  slotNumber: number;
  connectionState: "connected" | "reconnecting" | "offline";
  returnVideo: "program" | "preview" | "none";
  returnAudioBus: string;
  sourceGain: number;
  sourceMuted: boolean;
  sourceDelayMs: number;
  tracks: Array<{ sid: string; source: string; muted: boolean }>;
  commands: Array<DeskCommand & { status: string }>;
}

/**
 * One guest as a channel strip (alcantara#301): state, return, cue and talk in
 * one place. Talk is hold-to-talk (press and hold, or hold T while the strip
 * has focus) and always closes on release. The live cue is armed, then sent;
 * the wrap cue needs a hold. Mic meters and screening are not built yet and say
 * so.
 */
export function GuestStrip({
  participant,
  expiresAt,
  canOperate,
  busy,
  talking,
  draft,
  onDraftChange,
  onReturn,
  onCommand,
  onTalkStart,
  onTalkStop,
  onReplace,
  onRemove,
  onRevoke,
}: {
  participant: StripParticipant;
  expiresAt: string;
  canOperate: boolean;
  busy: boolean;
  talking: boolean;
  draft: string;
  onDraftChange: (value: string) => void;
  onReturn: (field: ReturnField, value: string | number | boolean) => void;
  onCommand: (payload: Record<string, unknown>) => void;
  onTalkStart: () => void;
  onTalkStop: () => void;
  onReplace: () => void;
  onRemove: () => void;
  onRevoke: () => void;
}) {
  const cue = latestCue(participant.commands);
  const state = stripState(participant.connectionState, cue);
  const connected = participant.connectionState === "connected";
  const microphone = participant.tracks.find((track) => track.source.includes("microphone"));
  const camera = participant.tracks.find((track) => track.source.includes("camera"));
  const latest = participant.commands[0];
  const [armed, setArmed] = useState(false);
  const [holding, setHolding] = useState(false);
  const [talkOnAir, setTalkOnAir] = useState(false);
  // Mute and remove are confirmed in plain words before they are sent; a request to turn a device back on is not.
  const [confirming, setConfirming] = useState<'mic' | 'camera' | 'remove' | null>(null);
  const holdTimer = useRef<number | null>(null);
  const talkHeld = useRef(false);

  // Talking to a guest who was cued live needs a second, explicit confirmation.
  const canTalk = canOperate && connected && !busy && (cue !== "live" || talkOnAir);

  useEffect(() => {
    if (!armed) return;
    const timer = window.setTimeout(() => setArmed(false), ARM_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [armed]);

  useEffect(
    () => () => {
      if (holdTimer.current !== null) window.clearTimeout(holdTimer.current);
    },
    [],
  );

  const startTalk = () => {
    if (!canTalk || talkHeld.current) return;
    talkHeld.current = true;
    onTalkStart();
  };
  const stopTalk = () => {
    if (!talkHeld.current) return;
    talkHeld.current = false;
    onTalkStop();
  };
  const sendCue = (next: Cue) => onCommand({ type: "cue", cue: next });
  const cueLive = () => {
    if (!armed) {
      setArmed(true);
      return;
    }
    setArmed(false);
    sendCue("live");
  };
  const startHold = () => {
    if (holdTimer.current !== null) return;
    setHolding(true);
    holdTimer.current = window.setTimeout(() => {
      holdTimer.current = null;
      setHolding(false);
      sendCue("wrap");
    }, HOLD_MS);
  };
  const cancelHold = () => {
    if (holdTimer.current !== null) window.clearTimeout(holdTimer.current);
    holdTimer.current = null;
    setHolding(false);
  };
  const cueDisabled = !canOperate || !connected || busy;

  return (
    <article
      className="guest-strip"
      data-state={state}
      aria-label={`Slot ${participant.slotNumber}: ${participant.name}`}
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) return;
        if ((event.key === "t" || event.key === "T") && !event.repeat) startTalk();
        if (event.key === " " && armed) {
          event.preventDefault();
          cueLive();
        }
      }}
      onKeyUp={(event) => {
        if (event.key === "t" || event.key === "T") stopTalk();
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) stopTalk();
      }}
    >
      <header className="guest-strip-head">
        <span className="guest-strip-slot">{String(participant.slotNumber).padStart(2, "0")}</span>
        <div className="min-w-0 flex-1">
          <h3 className="truncate font-medium">{participant.name}</h3>
          <p className="text-xs text-text-secondary">
            Expires {new Date(expiresAt).toLocaleString()}
          </p>
        </div>
        <span className="guest-strip-state" data-state={state}>
          {STRIP_LABEL[state]}
        </span>
      </header>
      {state === "cued-live" ? (
        <p className="guest-strip-note">
          Sent the live cue. The guest is on the output only through a scene that carries them.
        </p>
      ) : null}
      {confirming ? (
        <div role="group" aria-label="Confirm" className="guest-strip-row">
          <p className="text-sm">
            {confirming === 'remove'
              ? `Remove ${participant.name} from the call? They drop off now. Their link still works until it expires, so they can rejoin.`
              : confirming === 'mic'
                ? `Mute ${participant.name}'s microphone? They are asked to switch it off.`
                : `Turn off ${participant.name}'s camera? They are asked to switch it off.`}
          </p>
          <Button
            size="xs"
            variant="destructive"
            disabled={busy}
            onClick={() => {
              if (confirming === 'remove') onRemove();
              else onCommand({ type: 'media', device: confirming === 'mic' ? 'microphone' : 'camera', enabled: false });
              setConfirming(null);
            }}
          >
            {confirming === 'remove' ? 'Remove from call' : confirming === 'mic' ? 'Mute microphone' : 'Turn off camera'}
          </Button>
          <Button size="xs" variant="secondary" onClick={() => setConfirming(null)}>
            Keep
          </Button>
        </div>
      ) : null}
      <div className="guest-strip-av" aria-label="Audio and video">
        <span data-av={microphone ? (microphone.muted ? 'muted' : 'on') : 'none'}>
          {microphone ? (microphone.muted ? 'Audio muted' : 'Audio on') : 'Audio not sent'}
        </span>
        <span data-av={camera ? (camera.muted ? 'off' : 'on') : 'none'}>
          {camera ? (camera.muted ? 'Video off' : 'Video on') : 'Video not sent'}
        </span>
      </div>
      <div className="guest-strip-meter" aria-label="Mic level">
        <span>Mic</span>
        <span className="text-text-secondary">Meter not measured yet</span>
      </div>
      <div className="guest-strip-grid">
        <label>
          Return video
          <Select
            value={participant.returnVideo}
            disabled={!canOperate}
            onChange={(value) => onReturn("returnVideo", value)}
            options={[
              { value: "program", label: "Program" },
              { value: "preview", label: "Preview" },
              { value: "none", label: "None" },
            ]}
          />
        </label>
        <label>
          Return audio
          <Select
            value={participant.returnAudioBus}
            disabled={!canOperate}
            onChange={(value) => onReturn("returnAudioBus", value)}
            options={[
              { value: "master", label: "Program / Master" },
              { value: "monitor", label: "Operator monitor" },
              ...Array.from({ length: 8 }, (_, index) => ({
                value: `aux-${index + 1}`,
                label: `Aux / IFB ${index + 1}`,
              })),
            ]}
          />
        </label>
        <label>
          Level in returns
          <Select
            value={String(participant.sourceGain)}
            disabled={!canOperate}
            onChange={(value) => onReturn("sourceGain", Number(value))}
            options={[0, 0.25, 0.5, 0.75, 1].map((value) => ({
              value: String(value),
              label: `${Math.round(value * 100)}%`,
            }))}
          />
        </label>
        <label>
          Sync delay
          <Select
            value={String(participant.sourceDelayMs)}
            disabled={!canOperate}
            onChange={(value) => onReturn("sourceDelayMs", Number(value))}
            options={[0, 50, 100, 150, 200, 300, 500, 750, 1000, 1500, 2000].map((value) => ({
              value: String(value),
              label: `${value} ms`,
            }))}
          />
        </label>
      </div>
      <div className="guest-strip-row">
        <Button
          size="xs"
          variant={participant.sourceMuted ? "destructive" : "secondary"}
          disabled={!canOperate}
          onClick={() => onReturn("sourceMuted", !participant.sourceMuted)}
        >
          {participant.sourceMuted ? <MicOff size={13} /> : <Mic size={13} />}
          {participant.sourceMuted ? "Muted in returns" : "Routed to returns"}
        </Button>
        <Button
          size="xs"
          variant="secondary"
          disabled={!canOperate || !microphone || busy}
          onClick={() => (microphone?.muted ? onCommand({ type: "media", device: "microphone", enabled: true }) : setConfirming("mic"))}
        >
          {microphone?.muted ? <MicOff size={13} /> : <Mic size={13} />}
          {microphone?.muted ? "Request mic" : "Mute mic"}
        </Button>
        <Button
          size="xs"
          variant="secondary"
          disabled={!canOperate || !camera || busy}
          onClick={() => (camera?.muted ? onCommand({ type: "media", device: "camera", enabled: true }) : setConfirming("camera"))}
        >
          {camera?.muted ? <VideoOff size={13} /> : <Video size={13} />}
          {camera?.muted ? "Request camera" : "Mute camera"}
        </Button>
      </div>
      <div className="guest-strip-row">
        <span className="guest-strip-cue">Cue · {cue ?? "none sent"}</span>
        <Button size="xs" variant="secondary" disabled={cueDisabled} onClick={() => sendCue("standby")}>
          Standby
        </Button>
        <Button
          size="xs"
          variant={armed ? "destructive" : "secondary"}
          disabled={cueDisabled}
          aria-pressed={armed}
          onClick={cueLive}
        >
          {armed ? "Press again or Space: cue live" : "Cue live"}
        </Button>
        <Button
          size="xs"
          variant="secondary"
          disabled={cueDisabled}
          data-holding={holding}
          onPointerDown={startHold}
          onPointerUp={cancelHold}
          onPointerLeave={cancelHold}
          onKeyDown={(event) => {
            if ((event.key === "Enter" || event.key === " ") && !event.repeat) {
              event.preventDefault();
              startHold();
            }
          }}
          onKeyUp={(event) => {
            if (event.key === "Enter" || event.key === " ") cancelHold();
          }}
          title="Hold to send the wrap cue"
        >
          {holding ? "Keep holding…" : "Hold · cue wrap"}
        </Button>
      </div>
      <div className="guest-strip-row">
        <Button
          size="xs"
          variant={talking ? "destructive" : "secondary"}
          disabled={!canTalk && !talking}
          aria-pressed={talking}
          onPointerDown={startTalk}
          onPointerUp={stopTalk}
          onPointerLeave={stopTalk}
          title={
            cue === "live" && !talkOnAir
              ? "This guest was cued live: confirm talk on air first"
              : "Hold to talk privately, or hold T"
          }
        >
          <Headphones size={13} /> {talking ? "Talking… release to stop" : "Hold · talk (T)"}
        </Button>
        {cue === "live" ? (
          <label className="guest-strip-confirm">
            <input
              type="checkbox"
              checked={talkOnAir}
              disabled={!canOperate}
              onChange={(event) => setTalkOnAir(event.target.checked)}
            />
            Allow talk while cued live
          </label>
        ) : null}
      </div>
      <div className="guest-strip-row">
        <Input
          aria-label={`Message ${participant.name}`}
          value={draft}
          maxLength={500}
          onChange={(event) => onDraftChange(event.target.value)}
          placeholder="Private studio message"
        />
        <Button
          size="xs"
          aria-label={`Send message to ${participant.name}`}
          disabled={!canOperate || !draft.trim() || busy}
          onClick={() => onCommand({ type: "message", text: draft })}
        >
          <Send size={13} />
        </Button>
      </div>
      {latest ? (
        <p className="text-xs text-text-secondary">
          Latest {latest.type}: <strong>{latest.status}</strong>
        </p>
      ) : null}
      <footer className="guest-strip-row guest-strip-foot">
        <Button size="xs" variant="ghost" disabled={!canOperate || busy} onClick={onReplace}>
          <RefreshCw size={13} /> Replace link
        </Button>
        <Button
          size="xs"
          variant="ghost"
          disabled={!canOperate || participant.connectionState === "offline" || busy}
          onClick={() => setConfirming("remove")}
        >
          Remove session
        </Button>
        <Button size="xs" variant="destructive" disabled={!canOperate || busy} onClick={onRevoke}>
          <Trash2 size={13} /> Revoke
        </Button>
      </footer>
    </article>
  );
}
