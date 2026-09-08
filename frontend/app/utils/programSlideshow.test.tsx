import { describe, expect, it } from 'vitest';
import { getProgramSlideshowMediaGroupIds, getSceneSlideshowMediaGroupId } from './programSlideshow';

function scene(componentType: string, mediaGroupId: unknown) {
  return {
    layout: { componentType },
    metadata: JSON.stringify({ slideshow: { mediaGroupId } })
  };
}

describe('program slideshow media groups', () => {
  it('loads the staged slideshow group even when the active scene has no slideshow', () => {
    expect(getProgramSlideshowMediaGroupIds(scene('modoitaliano-clock', null), scene('modoitaliano-clock,slideshow', 12))).toEqual([12]);
  });

  it('loads distinct active and staged slideshow groups', () => {
    expect(getProgramSlideshowMediaGroupIds(scene('slideshow,modoitaliano-clock', 4), scene('modoitaliano-clock, slideshow', '9'))).toEqual([4, 9]);
  });

  it('ignores malformed metadata and scenes without the slideshow component', () => {
    expect(getSceneSlideshowMediaGroupId({ layout: { componentType: 'slideshow' }, metadata: '{' })).toBeNull();
    expect(getSceneSlideshowMediaGroupId(scene('modoitaliano-clock', 8))).toBeNull();
  });
});
