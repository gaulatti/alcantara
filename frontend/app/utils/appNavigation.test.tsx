import { describe, expect, it } from 'vitest';
import { getAppNavigationSections, isNavigationItemActive } from './appNavigation';

function labels(type: 'tv' | 'radio' | 'both') {
  return getAppNavigationSections({
    programType: type,
    canViewBroadcasts: true,
    includeDeveloperTools: false
  }).flatMap((section) => section.items.map((item) => item.label));
}

describe('program-aware application navigation', () => {
  it('keeps television-only preparation out of the radio workflow', () => {
    expect(labels('radio')).toEqual(['Radio desk', 'Rundown', 'Songs', 'Audio clips', 'Shows', 'Radio distribution']);
  });

  it('gives simulcast explicit access to both legs', () => {
    const simulcast = labels('both');
    expect(simulcast).toContain('Simulcast control');
    expect(simulcast).toContain('TV destinations');
    expect(simulcast).toContain('Radio distribution');
    expect(simulcast).toContain('Scene templates');
  });

  it('does not expose developer tools in the production navigation', () => {
    expect(labels('tv')).not.toContain('Component catalog');
  });

  it('treats the legacy control route as the live destination', () => {
    expect(isNavigationItemActive('/control', '/')).toBe(true);
    expect(isNavigationItemActive('/songs/12', '/songs')).toBe(true);
    expect(isNavigationItemActive('/media', '/songs')).toBe(false);
  });
});
