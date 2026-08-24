import { radioFaderToGain, toRadioMixerPayload } from './radio-mixer.utils';

describe('radio mixer payload', () => {
  it('uses the same console taper as the renderer', () => {
    expect(radioFaderToGain(0)).toBe(0);
    expect(radioFaderToGain(0.5)).toBeCloseTo(0.177828, 6);
    expect(radioFaderToGain(1)).toBe(1);
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
