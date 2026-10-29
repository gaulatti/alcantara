import { radioFaderToGain, toRadioMixerPayload } from './radio-mixer.utils';

describe('radio mixer payload', () => {
  it('uses the same console taper as the renderer', () => {
    expect(radioFaderToGain(0)).toBe(0);
    expect(radioFaderToGain(0.5)).toBeCloseTo(0.177828, 6);
    expect(radioFaderToGain(1)).toBe(1);
  });

  it('interpolates the quiet tail below the first taper point from -80 dB', () => {
    // fader 0.015 is half of the first 0.03 taper point: -80 + 10 * 0.5 = -75 dB
    expect(radioFaderToGain(0.015)).toBeCloseTo(10 ** (-75 / 20), 6);
    expect(radioFaderToGain(0.03)).toBeCloseTo(10 ** (-70 / 20), 6);
  });

  it('treats a non-finite fader as fully open', () => {
    expect(radioFaderToGain(Number.NaN)).toBe(1);
    expect(radioFaderToGain(Number.POSITIVE_INFINITY)).toBe(1);
  });

  it('mutes the song channel when only the instant channel is soloed', () => {
    const payload = toRadioMixerPayload({
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
      instantSolo: true,
      sceneInstantSolo: false,
      streamSolo: false,
      mixerChannels: [],
    });
    expect(payload.songMuted).toBe(true);
    expect(payload.instantMuted).toBe(false);
  });

  it('maps radio mute and solo state to Palazzo', () => {
    const payload = toRadioMixerPayload({
      mainMasterVolume: 1,
      songMasterVolume: 0.5,
      instantMasterVolume: 0.72,
      sceneInstantMasterVolume: 1,
      streamMasterVolume: 1,
      songMuted: false,
      instantMuted: false,
      sceneInstantMuted: false,
      streamMuted: false,
      songSolo: true,
      instantSolo: false,
      sceneInstantSolo: false,
      streamSolo: false,
      mixerChannels: [],
    });
    expect(payload.songMuted).toBe(false);
    expect(payload.instantMuted).toBe(true);
    expect(payload.songVolume).toBeCloseTo(0.177828, 6);
  });
});
