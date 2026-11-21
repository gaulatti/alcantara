import { describe, expect, it } from 'vitest';
import { getSceneSlideshowLabelId, getSceneSlideshowMediaGroupId } from './programSlideshow';

describe('slideshow scene metadata', () => {
  const scene = (componentType: string | null, metadata?: string | null) => ({ layout: { componentType }, metadata });

  it('reads the label id, else a legacy media group, only for slideshow scenes', () => {
    expect(getSceneSlideshowLabelId(scene('clock, slideshow', JSON.stringify({ slideshow: { labelId: ' trips ' } })))).toBe('trips');
    expect(getSceneSlideshowLabelId(scene('slideshow', JSON.stringify({ slideshow: { mediaGroupId: '12' } })))).toBe('legacy-media-group:12');
    expect(getSceneSlideshowMediaGroupId(scene('slideshow', JSON.stringify({ slideshow: { mediaGroupId: 12 } })))).toBe(12);
    expect(getSceneSlideshowLabelId(scene('clock', JSON.stringify({ slideshow: { labelId: 'x' } })))).toBeNull();
    expect(getSceneSlideshowLabelId(null)).toBeNull();
  });

  it('treats unreadable, non-object or missing slideshow metadata and invalid group ids as absent', () => {
    expect(getSceneSlideshowLabelId(scene('slideshow', '{not json'))).toBeNull();
    expect(getSceneSlideshowLabelId(scene('slideshow', '[1,2]'))).toBeNull();
    expect(getSceneSlideshowLabelId(scene('slideshow', JSON.stringify({ slideshow: [] })))).toBeNull();
    expect(getSceneSlideshowLabelId(scene('slideshow', null))).toBeNull();
    expect(getSceneSlideshowMediaGroupId(scene('slideshow', JSON.stringify({ slideshow: { mediaGroupId: 1.5 } })))).toBeNull();
    expect(getSceneSlideshowMediaGroupId(scene('slideshow', JSON.stringify({ slideshow: { mediaGroupId: -3 } })))).toBeNull();
    expect(getSceneSlideshowLabelId(scene('slideshow', JSON.stringify({ slideshow: { labelId: '  ', mediaGroupId: 'x' } })))).toBeNull();
    expect(getSceneSlideshowMediaGroupId(scene('clock'))).toBeNull();
  });
});
