import { describe, expect, it } from 'vitest';
import { normalizeFlightCue } from './programFlightSequence';

// gaulatti/alcantara#422 (R1): the console's copy of the cue parser keeps the recipe-use tag with the
// same rules as the backend, so a tag read back from a save is the tag that was written.

const tag = { useId: 'use-1', recipeId: 7, recipeRevision: 2, step: 'song', params: { songId: 42 } };
const cue = (recipeUse: unknown) => ({ id: 'use-1.song', kind: 'playSong', songId: 42, recipeUse });

describe('normalizeFlightCue keeps the recipe-use tag', () => {
  it('reads a well-formed tag back unchanged', () => {
    expect(normalizeFlightCue(cue(tag))?.recipeUse).toEqual(tag);
    expect(normalizeFlightCue(cue({ ...tag, params: { songId: 42, labelId: 'label-a' } }))?.recipeUse).toEqual({
      ...tag,
      params: { songId: 42, labelId: 'label-a' },
    });
  });

  it('drops a malformed tag and keeps the cue', () => {
    const parsed = normalizeFlightCue(cue({ ...tag, recipeRevision: 0 }));
    expect(parsed?.id).toBe('use-1.song');
    expect(parsed?.kind).toBe('playSong');
    expect(parsed?.recipeUse).toBeUndefined();
  });

  it.each([
    ['a blank step', { step: '  ' }],
    ['a recipeId that is fractional', { recipeId: 1.5 }],
    ['a songId that is zero', { params: { songId: 0 } }],
    ['a labelId that is a boolean', { params: { songId: 42, labelId: true } }],
  ])('drops a tag with %s', (_name, change) => {
    expect(normalizeFlightCue(cue({ ...tag, ...change }))?.recipeUse).toBeUndefined();
  });

  it('keeps a cue that has no tag without one', () => {
    expect(normalizeFlightCue({ id: 'plain', kind: 'playSong', songId: 42 })?.recipeUse).toBeUndefined();
  });
});
