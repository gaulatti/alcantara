import { radioFaderToGain, toRadioMixerPayload } from './radio-mixer.utils';

describe('radio mixer edge cases', () => {
  it('treats non-finite faders as unity and clamps to the unit range', () => {
    expect(radioFaderToGain(Number.NaN)).toBe(1);
    expect(radioFaderToGain(Infinity)).toBe(1);
    expect(radioFaderToGain(5)).toBe(1);
    expect(radioFaderToGain(-2)).toBe(0);
  });

  it('interpolates below the first taper point from -80 dB', () => {
    const fader = 0.015;
    const db = -80 + 10 * (fader / 0.03);
    expect(radioFaderToGain(fader)).toBeCloseTo(Math.pow(10, db / 20), 6);
    expect(radioFaderToGain(0.03)).toBeCloseTo(Math.pow(10, -70 / 20), 6);
  });

  it('interpolates between taper points', () => {
    expect(radioFaderToGain(0.12)).toBeCloseTo(Math.pow(10, -45 / 20), 6);
    expect(radioFaderToGain(0.88)).toBeCloseTo(Math.pow(10, -3 / 20), 6);
  });

  const base = {
    mainMasterVolume: 1,
    songMasterVolume: 1,
    instantMasterVolume: 1,
    sceneInstantMasterVolume: 1,
    streamMasterVolume: 1,
    songMuted: false,
    instantMuted: false,
    sceneInstantMuted: false,
    streamMuted: false,
    songSolo: false,
    instantSolo: false,
    sceneInstantSolo: false,
    streamSolo: false,
    mixerChannels: [],
  };

  it('leaves channels unmuted when nothing is soloed or muted', () => {
    const payload = toRadioMixerPayload(base);
    expect(payload).toEqual({
      mainVolume: 1,
      songVolume: 1,
      instantVolume: 1,
      songMuted: false,
      instantMuted: false,
    });
  });

  it('mutes the song channel when only instant is soloed', () => {
    const payload = toRadioMixerPayload({ ...base, instantSolo: true });
    expect(payload.songMuted).toBe(true);
    expect(payload.instantMuted).toBe(false);
  });

  it('honours explicit mutes even for a soloed channel', () => {
    const payload = toRadioMixerPayload({
      ...base,
      songMuted: true,
      songSolo: true,
      instantMuted: true,
    });
    expect(payload.songMuted).toBe(true);
    expect(payload.instantMuted).toBe(true);
  });
});
