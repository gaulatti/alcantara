import { normalizeFlightItems, normalizeRecipeUse } from './flight.service';
import { resolve } from './flight-resolver';
import type { FlightCue } from './flight.types';

// gaulatti/alcantara#422 (R1): a rundown cue keeps its recipe-use tag (contract C1) through the
// normalization that create, update and start run, and the resolver ignores it.

const START = 1_800_000_000_000;
const NO_DURATIONS = new Map<number, number>();
const tag = {
  useId: 'use-1',
  recipeId: 7,
  recipeRevision: 2,
  step: 'song',
  params: { songId: 42 },
};

describe('normalizeRecipeUse', () => {
  it('keeps a well-formed tag, with or without a label', () => {
    expect(normalizeRecipeUse(tag)).toEqual(tag);
    expect(
      normalizeRecipeUse({
        ...tag,
        params: { songId: 42, labelId: 'label-a' },
      }),
    ).toEqual({
      ...tag,
      params: { songId: 42, labelId: 'label-a' },
    });
    expect(
      normalizeRecipeUse({ ...tag, params: { songId: 42, labelId: null } }),
    ).toEqual({
      ...tag,
      params: { songId: 42, labelId: null },
    });
  });

  it.each([
    ['a missing useId', { useId: undefined }],
    ['a blank useId', { useId: '   ' }],
    ['a useId over 64 characters', { useId: 'x'.repeat(65) }],
    ['a missing step', { step: undefined }],
    ['a recipeId that is not a positive integer', { recipeId: 0 }],
    ['a recipeRevision that is fractional', { recipeRevision: 1.5 }],
    ['a songId that is negative', { params: { songId: -1 } }],
    ['a labelId that is a number', { params: { songId: 42, labelId: 9 } }],
    ['params that is not an object', { params: 'song-42' }],
    ['params that is an array', { params: [42] }],
  ])('drops a tag with %s', (_name, change) => {
    expect(normalizeRecipeUse({ ...tag, ...change })).toBeUndefined();
  });

  it('refuses a value that is not an object', () => {
    expect(normalizeRecipeUse('use-1')).toBeUndefined();
    expect(normalizeRecipeUse(null)).toBeUndefined();
  });
});

describe('rundown items keep the tag', () => {
  it('keeps a tag on a cue through normalization', () => {
    const [cue] = normalizeFlightItems([
      { id: 'use-1.song', kind: 'playSong', songId: 42, recipeUse: tag },
    ]);
    expect(cue.recipeUse).toEqual(tag);
  });

  it('drops a malformed tag and keeps the cue', () => {
    const [cue] = normalizeFlightItems([
      {
        id: 'use-1.song',
        kind: 'playSong',
        songId: 42,
        recipeUse: { ...tag, recipeId: 0 },
      },
    ]);
    expect(cue.id).toBe('use-1.song');
    expect(cue.kind).toBe('playSong');
    expect(cue.recipeUse).toBeUndefined();
  });
});

describe('the resolver ignores the tag', () => {
  it('resolves a tagged cue exactly as the same cue without the tag', () => {
    const plain: FlightCue[] = [{ id: 'take', kind: 'scene', sceneId: 1 }];
    const tagged: FlightCue[] = [
      { id: 'take', kind: 'scene', sceneId: 1, recipeUse: tag },
    ];
    expect(
      resolve(
        { items: tagged, loop: false },
        START,
        START + 1000,
        NO_DURATIONS,
      ),
    ).toEqual(
      resolve({ items: plain, loop: false }, START, START + 1000, NO_DURATIONS),
    );
  });
});
