import { bracketComponentFromLayout, GIORGIA_BRACKET_COMPONENT, LEGACY_BRACKET_COMPONENT } from './bracket-component';

// The real value of layout 2236 on production (dry run, 23:50 UTC) is a comma-separated list.
const REAL_LIST = 'modoitaliano-giorgia-clock,tournament-bracket,modoitaliano-bracket,slideshow';
const REAL_LIST_MIGRATED = 'modoitaliano-giorgia-clock,tournament-bracket,modoitaliano-giorgia-bracket,slideshow';

describe('bracketComponentFromLayout', () => {
  it('finds the legacy bracket element of the real list, not the tournament-bracket lookalike', () => {
    expect(bracketComponentFromLayout(REAL_LIST)).toBe(LEGACY_BRACKET_COMPONENT);
  });

  it('finds the Giorgia bracket element of the migrated real list', () => {
    expect(bracketComponentFromLayout(REAL_LIST_MIGRATED)).toBe(GIORGIA_BRACKET_COMPONENT);
  });

  it('reads a single-element componentType as before', () => {
    expect(bracketComponentFromLayout('modoitaliano-giorgia-bracket')).toBe(GIORGIA_BRACKET_COMPONENT);
    expect(bracketComponentFromLayout('modoitaliano-bracket')).toBe(LEGACY_BRACKET_COMPONENT);
  });

  it('returns null when the layout places no bracket, the value is empty, or the list has two bracket elements', () => {
    expect(bracketComponentFromLayout('modoitaliano-giorgia-clock,slideshow')).toBeNull();
    expect(bracketComponentFromLayout('')).toBeNull();
    expect(bracketComponentFromLayout(null)).toBeNull();
    expect(bracketComponentFromLayout(`${LEGACY_BRACKET_COMPONENT},${GIORGIA_BRACKET_COMPONENT}`)).toBeNull();
  });
});
