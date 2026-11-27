import { useCallback, useEffect, useRef, useState } from "react";
import { TooltipButton } from "../BleeckerButtons";

/** A file on air on a mixer channel, and how far into it the desk reads air to be. */
export interface PreFadeSource {
  key: string;
  url: string;
  /** Read when the audio is lined up, so a sounder's position is current. */
  positionMs: () => number;
  /** The sounder's own level, which applies before the channel fader. */
  volume?: number;
}

/** How far this device may drift from the desk's reading before it is lined up again. */
export const PRE_FADE_DRIFT_MS = 1_500;

/**
 * Pre-fade listen of one mixer channel on this device (gaulatti/alcantara#835). The browser plays the files that are
 * on air on the channel, lined up with them, at full level, so a muted or pulled-down channel is still heard. It
 * sends nothing: no fader, mute or playout request, and other operators hear nothing. It is the source file, not the
 * engine's processed signal. Esc or the same button stops it.
 */
export function ChannelPreListen({
  channel,
  label,
  sources,
  onActive,
  activeOwner = null,
}: {
  channel: string;
  label: string;
  sources: PreFadeSource[];
  onActive: (channel: string, active: boolean) => void;
  /** The pre-fade that holds the desk now: this one stops when another claims it. */
  activeOwner?: string | null;
}) {
  const [on, setOn] = useState(false);
  const [failed, setFailed] = useState(false);
  const playing = useRef(new Map<string, HTMLAudioElement>());
  const report = useRef(onActive);
  report.current = onActive;

  const silence = useCallback((keep: ReadonlySet<string> = new Set()) => {
    for (const [key, audio] of playing.current) {
      if (keep.has(key)) continue;
      audio.pause();
      playing.current.delete(key);
    }
  }, []);

  const lineUp = useCallback(
    (wanted: PreFadeSource[]) => {
      silence(new Set(wanted.map((source) => source.key)));
      for (const source of wanted) {
        const position = Math.max(0, source.positionMs());
        let audio = playing.current.get(source.key);
        const added = !audio;
        if (!audio) {
          audio = new Audio(source.url);
          playing.current.set(source.key, audio);
        }
        audio.volume = Math.min(1, Math.max(0, source.volume ?? 1));
        const moved = added || Math.abs(audio.currentTime * 1000 - position) > PRE_FADE_DRIFT_MS;
        if (moved) audio.currentTime = position / 1000;
        // Lined up again after the file had stopped, for example air went back: it plays on from there.
        if (added || (moved && audio.paused && !audio.ended)) {
          const started = audio;
          void Promise.resolve(started.play()).catch(() => {
            // A file already replaced by the next one does not fail the pre-listen.
            if (playing.current.get(source.key) === started) setFailed(true);
          });
        }
      }
    },
    [silence],
  );

  const stop = useCallback(() => {
    silence();
    setOn(false);
  }, [silence]);

  // Follows air: the next song, a new sounder, a correction of the position.
  useEffect(() => {
    if (on) lineUp(sources);
  }, [on, sources, lineUp]);

  // Another pre-fade (a guest, the other channel, a sounder) took the desk: this one stops.
  useEffect(() => {
    if (on && activeOwner !== null && activeOwner !== channel) stop();
  }, [on, activeOwner, channel, stop]);

  useEffect(() => {
    if (!on) return;
    report.current(channel, true);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") stop();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      report.current(channel, false);
    };
  }, [on, channel, stop]);

  useEffect(() => () => silence(), [silence]);

  return (
    <div className="space-y-1">
      <TooltipButton
        type="button"
        aria-label={`Pre-listen ${label}`}
        aria-pressed={on}
        title={`Hear what is on ${label} before its fader, on this device only`}
        onClick={() => {
          if (on) {
            stop();
            return;
          }
          setFailed(false);
          // Claim the desk before sounding, so the other pre-fade stops in the same update.
          report.current(channel, true);
          setOn(true);
          // Inside the click, so a browser that blocks sound without one lets it play.
          lineUp(sources);
        }}
      >
        PFL
      </TooltipButton>
      {on ? (
        <p role={failed ? "alert" : "status"} className="text-[10px] text-accent-yellow">
          {failed ? "Could not be played here" : sources.length ? "PFL · this device only" : "PFL · nothing on air here"}
        </p>
      ) : null}
    </div>
  );
}
