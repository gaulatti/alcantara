import {
  RECIPE_STEPS,
  cueIdFor,
  expandRecipe,
  findRecipeUses,
  firstComponent,
  isUseId,
  newUseId,
  normalizeRecipeSteps,
  stepsUsingLabel,
  type RecipeDefinition,
} from './recipe-expand';

const recipe = (over: Partial<RecipeDefinition> = {}): RecipeDefinition => ({
  id: 7,
  revision: 3,
  bumperSceneId: 11,
  slideshowSceneId: 12,
  returnSceneId: 13,
  transitionId: 'cut',
  holdMs: 3000,
  steps: [...RECIPE_STEPS],
  ...over,
});
const song = { id: 42, artist: 'Fictional Artist', title: 'Fictional Song' };
const USE = 'use_0123456789ab';

describe('expandRecipe (gaulatti/alcantara#424)', () => {
  it('writes the eight steps of the song recipe as ordinary cues, tagged and with stable ids', () => {
    const cues = expandRecipe(recipe(), song, 'label-1', USE, 'artist-bumper');
    expect(cues.map((cue) => [cue.id, cue.kind])).toEqual([
      [`${USE}.bumperPoint`, 'sceneUpdate'],
      [`${USE}.bumper`, 'scene'],
      [`${USE}.hold`, 'wait'],
      [`${USE}.song`, 'playSong'],
      [`${USE}.slideshowPoint`, 'sceneUpdate'],
      [`${USE}.slideshow`, 'scene'],
      [`${USE}.songEnd`, 'waitForSongEnd'],
      [`${USE}.back`, 'scene'],
    ]);
    expect(cues[0]).toMatchObject({
      sceneId: 11,
      metadataPatch: {
        'artist-bumper': {
          artist: 'Fictional Artist',
          songTitle: 'Fictional Song',
          labelId: 'label-1',
        },
      },
    });
    expect(cues[1]).toMatchObject({ sceneId: 11, transitionId: 'cut' });
    expect(cues[2]).toMatchObject({ durationMs: 3000 });
    expect(cues[3]).toMatchObject({ songId: 42 });
    expect(cues[4]).toMatchObject({
      sceneId: 12,
      metadataPatch: { slideshow: { labelId: 'label-1' } },
    });
    expect(cues[7]).toMatchObject({ sceneId: 13, transitionId: 'cut' });
    for (const cue of cues)
      expect(cue.recipeUse).toEqual({
        useId: USE,
        recipeId: 7,
        recipeRevision: 3,
        step: cue.id.split('.')[1],
        params: { songId: 42, labelId: 'label-1' },
      });
  });

  it('leaves out the steps whose scene is not set, and a hold of 0', () => {
    const cues = expandRecipe(
      recipe({
        bumperSceneId: null,
        slideshowSceneId: null,
        returnSceneId: null,
        holdMs: 0,
      }),
      song,
      null,
      USE,
    );
    expect(cues.map((cue) => cue.recipeUse.step)).toEqual(['song', 'songEnd']);
  });

  it('skips the bumper step when the bumper scene has no component to point', () => {
    const cues = expandRecipe(recipe(), song, null, USE);
    expect(cues.map((cue) => cue.recipeUse.step)).not.toContain('bumperPoint');
    expect(cues.map((cue) => cue.recipeUse.step)).toContain('bumper');
  });

  it('reads the first component of a layout', () => {
    expect(firstComponent(' artist-bumper , logo')).toBe('artist-bumper');
    expect(firstComponent('')).toBeNull();
    expect(firstComponent(null)).toBeNull();
  });

  it('builds only the enabled steps', () => {
    const cues = expandRecipe(
      recipe({ steps: ['song', 'songEnd'] }),
      song,
      null,
      USE,
    );
    expect(cues.map((cue) => cue.kind)).toEqual(['playSong', 'waitForSongEnd']);
  });

  it('points the scenes at no label when there is none, so a previous use does not linger', () => {
    const cues = expandRecipe(recipe(), song, null, USE, 'artist-bumper');
    expect(cues[0].metadataPatch).toEqual({
      'artist-bumper': {
        artist: 'Fictional Artist',
        songTitle: 'Fictional Song',
        labelId: null,
      },
    });
    expect(cues[4].metadataPatch).toEqual({ slideshow: { labelId: null } });
  });
});

describe('recipe steps', () => {
  it('keeps the enabled steps in airing order, each once', () => {
    expect(normalizeRecipeSteps(['back', 'song', 'song', 'bumper'])).toEqual([
      'bumper',
      'song',
      'back',
    ]);
  });
  it('defaults to all eight', () => {
    expect(normalizeRecipeSteps(undefined)).toEqual([...RECIPE_STEPS]);
    expect(normalizeRecipeSteps(null)).toEqual([...RECIPE_STEPS]);
  });
  it('refuses an unknown step or a non-list', () => {
    expect(() => normalizeRecipeSteps(['song', 'dance'])).toThrow(
      'unknown recipe step dance',
    );
    expect(() => normalizeRecipeSteps('song')).toThrow('steps must be a list');
  });
  it('knows which steps need a label', () => {
    expect(stepsUsingLabel(['song', 'songEnd'])).toBe(false);
    expect(stepsUsingLabel(['slideshowPoint'])).toBe(true);
    expect(stepsUsingLabel(['bumperPoint'])).toBe(true);
  });
});

describe('use ids', () => {
  it('are use_ and 12 hex characters', () => {
    const id = newUseId(() => Buffer.from('0123456789ab', 'hex'));
    expect(id).toBe('use_0123456789ab');
    expect(isUseId(newUseId())).toBe(true);
    expect(isUseId('use_xyz')).toBe(false);
    expect(isUseId(5)).toBe(false);
    expect(cueIdFor(USE, 'song')).toBe(`${USE}.song`);
  });
});

describe('findRecipeUses', () => {
  const use = (useId: string, revision = 3) =>
    expandRecipe(
      recipe({ revision, steps: ['song', 'songEnd'] }),
      song,
      null,
      useId,
    );
  const plain = (id: string) => ({ id, kind: 'wait', durationMs: 1 });

  it('finds each contiguous use with where it is and what it was built from', () => {
    const items = [
      plain('a'),
      ...use('use_aaaaaaaaaaaa', 2),
      plain('b'),
      ...use('use_bbbbbbbbbbbb'),
    ];
    expect(findRecipeUses(items)).toEqual([
      {
        useId: 'use_aaaaaaaaaaaa',
        recipeId: 7,
        recipeRevision: 2,
        params: { songId: 42, labelId: null },
        start: 1,
        end: 3,
      },
      {
        useId: 'use_bbbbbbbbbbbb',
        recipeId: 7,
        recipeRevision: 3,
        params: { songId: 42, labelId: null },
        start: 4,
        end: 6,
      },
    ]);
  });

  it('ignores a use split by hand-placed cues, and malformed tags', () => {
    const [first, second] = use('use_cccccccccccc');
    const items = [
      first,
      plain('x'),
      second,
      {
        id: 'bad',
        kind: 'wait',
        recipeUse: {
          useId: 'nope',
          recipeId: 7,
          recipeRevision: 1,
          step: 'song',
          params: { songId: 1 },
        },
      },
      { id: 'bad2', kind: 'wait', recipeUse: 'text' },
      {
        id: 'bad3',
        kind: 'wait',
        recipeUse: {
          useId: 'use_eeeeeeeeeeee',
          recipeId: 7,
          recipeRevision: 1,
          step: 'song',
        },
      },
      null,
    ];
    expect(findRecipeUses(items)).toEqual([]);
  });

  it('reads a string label from a tag', () => {
    const items = expandRecipe(
      recipe({ steps: ['song'] }),
      song,
      'label-9',
      'use_dddddddddddd',
    );
    expect(findRecipeUses(items)[0].params).toEqual({
      songId: 42,
      labelId: 'label-9',
    });
  });
});
