import { describe, expect, it } from 'vitest';
import { getSceneTransitionPreset, SCENE_TRANSITIONS } from './sceneTransitions';

describe('scene transition presets', () => {
  it('returns the named preset, trimming it, and the cut for a missing or unknown id', () => {
    const cut = getSceneTransitionPreset('cut');
    const other = SCENE_TRANSITIONS.find((preset) => preset !== cut)!;
    expect(getSceneTransitionPreset(` ${other.id} `)).toBe(other);
    expect(getSceneTransitionPreset(null)).toBe(cut);
    expect(getSceneTransitionPreset('')).toBe(cut);
    expect(getSceneTransitionPreset('no-such-transition')).toBe(cut);
  });
});
