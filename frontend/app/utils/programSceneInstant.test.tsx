import { describe, expect, it } from 'vitest';
import { sceneInstantBelongsToActiveScene } from './programSceneInstant';

describe('program scene instant ownership', () => {
  it('keeps a background instant only while its scene remains active', () => {
    expect(sceneInstantBelongsToActiveScene(12, 12)).toBe(true);
  });

  it('stops a background instant after Program changes scenes', () => {
    expect(sceneInstantBelongsToActiveScene(12, 18)).toBe(false);
  });

  it('stops a background instant when Program is cleared', () => {
    expect(sceneInstantBelongsToActiveScene(12, null)).toBe(false);
  });
});
