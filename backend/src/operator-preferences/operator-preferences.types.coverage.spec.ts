import { BadRequestException } from '@nestjs/common';
import {
  DEVICE_CLASSES,
  defaultProfile,
  parseDeviceClass,
  parseProfile,
} from './operator-preferences.types';

const base = { selectedProgramId: 'main' };

describe('operator preference types coverage', () => {
  describe('parseDeviceClass', () => {
    it.each(DEVICE_CLASSES)('accepts %s', (deviceClass) => {
      expect(parseDeviceClass(deviceClass)).toBe(deviceClass);
    });

    it('rejects anything else with a 400', () => {
      expect(() => parseDeviceClass('Desktop')).toThrow(BadRequestException);
      expect(() => parseDeviceClass('')).toThrow(
        'deviceClass must be desktop, tablet, or phone',
      );
    });
  });

  describe('defaultProfile', () => {
    it('gives tablet a compact touch layout with a 300px dock', () => {
      expect(defaultProfile('tablet')).toEqual({
        workspace: 'compact',
        dockWidth: 300,
        touchMode: true,
        shortcutsEnabled: false,
        selectedProgramId: 'main',
        transitions: { main: 'crescendo-prism' },
      });
    });

    it('gives desktop a director layout with a 320px dock', () => {
      expect(defaultProfile('desktop')).toEqual({
        workspace: 'director',
        dockWidth: 320,
        touchMode: false,
        shortcutsEnabled: true,
        selectedProgramId: 'main',
        transitions: { main: 'crescendo-prism' },
      });
    });
  });

  describe('parseProfile', () => {
    it.each([null, undefined, 'text', 5, []])(
      'rejects non-object profile %p',
      (value) => {
        expect(() => parseProfile(value, 'desktop')).toThrow(
          'profile must be an object',
        );
      },
    );

    it.each([
      [undefined],
      [5],
      ['x'.repeat(129)],
      ['-bad'],
      ['has space'],
      [''],
    ])('rejects selectedProgramId %p', (selectedProgramId) => {
      expect(() => parseProfile({ selectedProgramId }, 'desktop')).toThrow(
        'selectedProgramId is invalid',
      );
    });

    it('keeps a valid workspace and applies explicit flags on desktop', () => {
      expect(
        parseProfile(
          {
            ...base,
            workspace: 'audio',
            touchMode: true,
            shortcutsEnabled: false,
            dockWidth: 400.6,
          },
          'desktop',
        ),
      ).toEqual({
        workspace: 'audio',
        dockWidth: 401,
        touchMode: true,
        shortcutsEnabled: false,
        selectedProgramId: 'main',
        transitions: {},
      });
    });

    it('falls back to the class default workspace for unknown values', () => {
      expect(
        parseProfile({ ...base, workspace: 'nope' }, 'desktop').workspace,
      ).toBe('director');
      expect(parseProfile({ ...base }, 'tablet').workspace).toBe('compact');
    });

    it('defaults touchMode off and shortcuts on when unspecified on non-phone classes', () => {
      const profile = parseProfile({ ...base, touchMode: 'yes' }, 'tablet');
      expect(profile.touchMode).toBe(false);
      expect(profile.shortcutsEnabled).toBe(true);
    });

    it.each([
      [259, 320],
      [521, 320],
      ['abc', 320],
      [undefined, 320],
      [Infinity, 320],
      [260, 260],
      [520, 520],
      ['300', 300],
    ])('bounds dockWidth %p to %p', (dockWidth, expected) => {
      expect(parseProfile({ ...base, dockWidth }, 'desktop').dockWidth).toBe(
        expected,
      );
    });

    it('uses the tablet default dock width when out of range', () => {
      expect(parseProfile({ ...base, dockWidth: 1 }, 'tablet').dockWidth).toBe(
        300,
      );
    });

    it('omits dockWidth and forces compact touch for phones', () => {
      const profile = parseProfile(
        { ...base, workspace: 'audio', dockWidth: 400, shortcutsEnabled: true },
        'phone',
      );
      expect(profile).toEqual({
        workspace: 'compact',
        touchMode: true,
        shortcutsEnabled: false,
        selectedProgramId: 'main',
        transitions: {},
      });
      expect(profile).not.toHaveProperty('dockWidth');
    });

    describe('transitions', () => {
      it.each([undefined, null, 'text', 5, ['a']])(
        'treats non-record transitions %p as empty',
        (transitions) => {
          expect(
            parseProfile({ ...base, transitions }, 'desktop').transitions,
          ).toEqual({});
        },
      );

      it('keeps only well-formed program and transition identifiers', () => {
        const result = parseProfile(
          {
            ...base,
            transitions: {
              main: 'cut',
              'bad key': 'cut',
              '-lead': 'cut',
              ok2: 'bad value!',
              ok3: 12,
              ok4: '',
              ok5: 'fade.v2_x-1',
            },
          },
          'desktop',
        );
        expect(result.transitions).toEqual({ main: 'cut', ok5: 'fade.v2_x-1' });
      });

      it('considers only the first 100 entries', () => {
        const transitions: Record<string, string> = {};
        for (let i = 0; i < 105; i += 1) transitions[`p${i}`] = 'cut';
        const result = parseProfile(
          { ...base, transitions },
          'desktop',
        ).transitions;
        expect(Object.keys(result)).toHaveLength(100);
        expect(result).toHaveProperty('p99');
        expect(result).not.toHaveProperty('p100');
      });

      it('accepts 128-character identifiers and rejects 129', () => {
        const ok = 'a'.repeat(128);
        const tooLong = 'a'.repeat(129);
        const result = parseProfile(
          { ...base, transitions: { [ok]: ok, [tooLong]: 'cut' } },
          'desktop',
        );
        expect(result.transitions).toEqual({ [ok]: ok });
      });
    });
  });
});
