import {
  bracketComponentFromLayout,
  bracketComponentFromState,
} from './bracket-component';

// The real value of layout 2236 on production (dry run, 23:50 UTC) is a comma-separated list. Its element names
// are the production ids; the spec is not counted by the brand-literal ratchet.
const REAL_LIST =
  'modoitaliano-giorgia-clock,tournament-bracket,modoitaliano-bracket,slideshow';
const REAL_LIST_MIGRATED =
  'modoitaliano-giorgia-clock,tournament-bracket,modoitaliano-giorgia-bracket,slideshow';

describe('bracketComponentFromLayout', () => {
  it('settles the real list by the scene state, not by the tournament-bracket lookalike', () => {
    expect(
      bracketComponentFromLayout(REAL_LIST, ['modoitaliano-bracket']),
    ).toBe('modoitaliano-bracket');
    expect(
      bracketComponentFromLayout(REAL_LIST_MIGRATED, [
        'modoitaliano-giorgia-bracket',
      ]),
    ).toBe('modoitaliano-giorgia-bracket');
  });

  it('refuses to guess between two bracket elements when the scene holds neither state', () => {
    expect(bracketComponentFromLayout(REAL_LIST, [])).toBeNull();
    // The list holds only the legacy element, so the scene's state settles it even when a second key is present.
    expect(
      bracketComponentFromLayout(REAL_LIST, [
        'modoitaliano-bracket',
        'modoitaliano-giorgia-bracket',
      ]),
    ).toBe('modoitaliano-bracket');
  });

  it('reads a list with a single bracket element without the scene state', () => {
    expect(
      bracketComponentFromLayout(
        'modoitaliano-giorgia-clock,modoitaliano-giorgia-bracket,slideshow',
      ),
    ).toBe('modoitaliano-giorgia-bracket');
    expect(bracketComponentFromLayout('modoitaliano-giorgia-bracket')).toBe(
      'modoitaliano-giorgia-bracket',
    );
  });

  it('returns null when the layout places no bracket, or the value is empty', () => {
    expect(
      bracketComponentFromLayout('modoitaliano-giorgia-clock,slideshow'),
    ).toBeNull();
    expect(bracketComponentFromLayout('')).toBeNull();
    expect(bracketComponentFromLayout(null)).toBeNull();
  });
});

describe('bracketComponentFromState', () => {
  it('returns the one metadata key that names a bracket, and nothing when there is not exactly one', () => {
    expect(
      bracketComponentFromState([
        'modoitaliano-giorgia-clock',
        'modoitaliano-giorgia-bracket',
      ]),
    ).toBe('modoitaliano-giorgia-bracket');
    expect(bracketComponentFromState(['modoitaliano-bracket'])).toBe(
      'modoitaliano-bracket',
    );
    expect(
      bracketComponentFromState([
        'modoitaliano-bracket',
        'modoitaliano-giorgia-bracket',
      ]),
    ).toBeNull();
    expect(bracketComponentFromState([])).toBeNull();
  });
});
