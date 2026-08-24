import type { ProgramAudioMixerSettings } from '../program/program.service';
import type { RadioMixerPayload } from './radio.service';

const TAPER = [
  { fader: 0.03, db: -70 },
  { fader: 0.12, db: -45 },
  { fader: 0.28, db: -28 },
  { fader: 0.5, db: -15 },
  { fader: 0.72, db: -8 },
  { fader: 0.88, db: -3 },
  { fader: 1, db: 0 },
] as const;

export function radioFaderToGain(value: number): number {
  const fader = Math.max(0, Math.min(1, Number.isFinite(value) ? value : 1));
  if (fader <= 0) return 0;
  let db = -80;
  if (fader <= TAPER[0].fader) {
    db = -80 + (-70 + 80) * (fader / TAPER[0].fader);
  } else {
    for (let index = 1; index < TAPER.length; index += 1) {
      const previous = TAPER[index - 1];
      const next = TAPER[index];
      if (fader <= next.fader) {
        const ratio = (fader - previous.fader) / (next.fader - previous.fader);
        db = previous.db + (next.db - previous.db) * ratio;
        break;
      }
    }
  }
  return Number(Math.pow(10, db / 20).toFixed(6));
}

export function toRadioMixerPayload(
  settings: ProgramAudioMixerSettings,
): RadioMixerPayload {
  const hasSolo = settings.songSolo || settings.instantSolo;
  return {
    mainVolume: radioFaderToGain(settings.mainMasterVolume),
    songVolume: radioFaderToGain(settings.songMasterVolume),
    instantVolume: radioFaderToGain(settings.instantMasterVolume),
    songMuted: settings.songMuted || (hasSolo && !settings.songSolo),
    instantMuted: settings.instantMuted || (hasSolo && !settings.instantSolo),
  };
}
