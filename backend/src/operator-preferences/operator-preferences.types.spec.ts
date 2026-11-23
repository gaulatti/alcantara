import {
  defaultProfile,
  parseDeviceClass,
  parseProfile,
} from './operator-preferences.types';

describe('operator preference schema', () => {
  it('provides class-specific defaults', () => {
    expect(defaultProfile('desktop')).toMatchObject({
      workspace: 'director',
      dockWidth: 320,
      touchMode: false,
      shortcutsEnabled: true,
    });
    expect(defaultProfile('phone')).toEqual({
      workspace: 'compact',
      touchMode: true,
      shortcutsEnabled: false,
      selectedProgramId: 'main',
      transitions: { main: 'crescendo-prism' },
    });
  });

  it('ignores unsupported phone settings and bounds transition keys', () => {
    expect(
      parseProfile(
        {
          workspace: 'graphics',
          dockWidth: 500,
          touchMode: false,
          shortcutsEnabled: true,
          selectedProgramId: 'main',
          transitions: { main: 'cut', 'bad/program': 'secret' },
        },
        'phone',
      ),
    ).toEqual({
      workspace: 'compact',
      touchMode: true,
      shortcutsEnabled: false,
      selectedProgramId: 'main',
      transitions: { main: 'cut' },
    });
  });

  it('rejects unknown classes and malformed profiles', () => {
    expect(() => parseDeviceClass('watch')).toThrow();
    expect(() => parseProfile(null, 'desktop')).toThrow();
    expect(() =>
      parseProfile(
        { selectedProgramId: '../other', transitions: {} },
        'desktop',
      ),
    ).toThrow();
  });

  it('defaults tablet profiles to the compact workspace with a 300px dock', () => {
    expect(defaultProfile('tablet')).toEqual({
      workspace: 'compact',
      dockWidth: 300,
      touchMode: true,
      shortcutsEnabled: false,
      selectedProgramId: 'main',
      transitions: { main: 'crescendo-prism' },
    });
  });

  it('drops invalid transition values and non-record transition containers', () => {
    const base = { workspace: 'audio', selectedProgramId: 'main' };
    expect(
      parseProfile(
        {
          ...base,
          transitions: { main: 42, other: 'bad/value', third: 'cut' },
        },
        'desktop',
      ).transitions,
    ).toEqual({ third: 'cut' });
    expect(
      parseProfile({ ...base, transitions: ['cut'] }, 'desktop').transitions,
    ).toEqual({});
    expect(
      parseProfile({ ...base, transitions: 'cut' }, 'desktop').transitions,
    ).toEqual({});
  });

  it('replaces out-of-range or non-numeric dock widths with the class default', () => {
    const base = { selectedProgramId: 'main' };
    expect(parseProfile({ ...base, dockWidth: 9000 }, 'tablet').dockWidth).toBe(
      300,
    );
    expect(
      parseProfile({ ...base, dockWidth: 'wide' }, 'desktop').dockWidth,
    ).toBe(320);
    expect(
      parseProfile({ ...base, dockWidth: 400.4 }, 'tablet').dockWidth,
    ).toBe(400);
  });
});
