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
});
