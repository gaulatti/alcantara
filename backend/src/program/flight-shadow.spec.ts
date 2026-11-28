import type { FlightDesiredState } from './flight-resolver.types';
import { compareShadow, shadowObserves } from './flight-shadow';

// The rundown shadow (gaulatti/alcantara#123, slice A): what the resolver says should be on air against what is.
const desired = (over: Partial<FlightDesiredState> = {}): FlightDesiredState => ({
  scene: { sceneId: 4, transitionId: null },
  sceneMetadataPatch: {},
  song: { songId: 9, positionMs: 1_000 },
  mixer: {},
  activeCueId: 'wait-1',
  finished: false,
  ...over,
});

describe('compareShadow', () => {
  it('agrees field by field when the cue, the scene and the song match', () => {
    expect(compareShadow(desired(), { activeCueId: 'wait-1', sceneId: 4, songId: 9 })).toEqual({
      cue: 'agree',
      scene: 'agree',
      song: 'agree',
    });
  });

  it('disagrees on each field that differs, with nothing on either side counted as a value', () => {
    expect(compareShadow(desired(), { activeCueId: 'wait-2', sceneId: 5, songId: 10 })).toEqual({
      cue: 'disagree',
      scene: 'disagree',
      song: 'disagree',
    });
    expect(compareShadow(desired({ scene: null, song: null, activeCueId: null }), { activeCueId: null, sceneId: null, songId: null })).toEqual({
      cue: 'agree',
      scene: 'agree',
      song: 'agree',
    });
    expect(compareShadow(desired({ scene: null, song: null }), { activeCueId: 'wait-1', sceneId: 4, songId: 9 })).toEqual({
      cue: 'agree',
      scene: 'disagree',
      song: 'disagree',
    });
    expect(compareShadow(desired({ song: { songId: null, positionMs: 0 } }), { activeCueId: 'wait-1', sceneId: 4, songId: null })).toEqual({
      cue: 'agree',
      scene: 'agree',
      song: 'agree',
    });
  });
});

describe('shadowObserves', () => {
  it('observes a wait for a song end and a wait long enough to tell apart', () => {
    expect(shadowObserves({ id: 's', kind: 'waitForSongEnd' })).toBe(true);
    expect(shadowObserves({ id: 'w', kind: 'wait', durationMs: 200 })).toBe(true);
  });

  it('does not observe a wait too short to tell apart, or a cue that does not wait', () => {
    expect(shadowObserves({ id: 'w', kind: 'wait', durationMs: 199 })).toBe(false);
    expect(shadowObserves({ id: 'w', kind: 'wait' })).toBe(false);
    expect(shadowObserves({ id: 'c', kind: 'scene', sceneId: 1 })).toBe(false);
  });
});
