import { parsePalazzoState } from './palazzo-contract';

describe('Palazzo track field admission', () => {
  it.each([undefined, 'not a track'])(
    'rejects an omitted or non-record track while accepting explicit idle null (%#)',
    (track) => {
      const snapshot = {
        schemaVersion: 1,
        instanceId: 'instance',
        bootId: 'boot',
        sequence: 1,
        availability: 'available',
        status: 'idle',
        intro: null,
        liquidsoap: {
          running: true,
          connected: true,
          staleSince: null,
          lastSampleAt: null,
        },
        icecast: { connected: true },
        positionSeconds: 0,
        remainingSeconds: null,
        levels: {
          song: { rms: 0, peak: 0 },
          instant: { rms: 0, peak: 0 },
          output: { rms: 0, peak: 0 },
        },
      };
      expect(parsePalazzoState({ ...snapshot, track })).toBeNull();
      expect(parsePalazzoState({ ...snapshot, track: null })).toMatchObject({
        track: null,
        status: 'idle',
      });
    },
  );
});
