import { afterEach, describe, expect, it, vi } from 'vitest';
import { getSupportedTimezones, getTimezoneOptionLabel, getTimezonesSortedByOffset } from './timezones';

describe('time zones', () => {
  afterEach(() => vi.restoreAllMocks());

  it('uses the browser list when it has one, and the built-in list when it is missing, empty or throws', () => {
    const intl = Intl as unknown as { supportedValuesOf?: (key: string) => string[] };
    const original = intl.supportedValuesOf;
    try {
      intl.supportedValuesOf = () => ['Europe/Rome', 'UTC'];
      expect(getSupportedTimezones()).toEqual(['Europe/Rome', 'UTC']);
      intl.supportedValuesOf = () => [];
      const fallback = getSupportedTimezones();
      expect(fallback.length).toBeGreaterThan(0);
      intl.supportedValuesOf = () => {
        throw new Error('unsupported');
      };
      expect(getSupportedTimezones()).toEqual(fallback);
      intl.supportedValuesOf = undefined;
      expect(getSupportedTimezones()).toEqual(fallback);
    } finally {
      intl.supportedValuesOf = original;
    }
  });

  it('labels a zone by city and GMT offset, using GMT when the zone is unknown', () => {
    const winter = new Date('2026-01-15T12:00:00Z');
    expect(getTimezoneOptionLabel('UTC', winter)).toBe('UTC (GMT+0)');
    expect(getTimezoneOptionLabel('America/New_York', winter)).toBe('New York (GMT-5)');
    expect(getTimezoneOptionLabel('Asia/Kathmandu', winter)).toBe('Kathmandu (GMT+5:45)');
    expect(getTimezoneOptionLabel('Not/A_Zone', winter)).toBe('A Zone (GMT)');
  });

  it('sorts zones west to east, then by label, reading half-hour offsets', () => {
    const intl = Intl as unknown as { supportedValuesOf?: (key: string) => string[] };
    const original = intl.supportedValuesOf;
    try {
      intl.supportedValuesOf = () => ['Asia/Kathmandu', 'UTC', 'America/New_York', 'Europe/London', 'Asia/Kolkata'];
      expect(getTimezonesSortedByOffset(new Date('2026-01-15T12:00:00Z'))).toEqual([
        'America/New_York',
        'Europe/London',
        'UTC',
        'Asia/Kolkata',
        'Asia/Kathmandu',
      ]);
    } finally {
      intl.supportedValuesOf = original;
    }
  });
});

describe('time zones the browser cannot describe', () => {
  afterEach(() => vi.restoreAllMocks());

  it('sorts unknown zones and unreadable offsets at GMT, labelling a zone with no city by its id', () => {
    const intl = Intl as unknown as { supportedValuesOf?: (key: string) => string[] };
    const original = intl.supportedValuesOf;
    try {
      intl.supportedValuesOf = () => ['Asia/Kolkata', 'Not/A_Zone', 'America/New_York', 'Broken/'];
      expect(getTimezonesSortedByOffset(new Date('2026-01-15T12:00:00Z'))).toEqual([
        'America/New_York',
        'Not/A_Zone',
        'Broken/',
        'Asia/Kolkata',
      ]);
      expect(getTimezoneOptionLabel('Broken/')).toBe('Broken/ (GMT)');

      intl.supportedValuesOf = () => ['Europe/Rome', 'America/New_York'];
      vi.spyOn(Intl.DateTimeFormat.prototype, 'formatToParts').mockReturnValue([
        { type: 'timeZoneName', value: 'CET' },
      ]);
      expect(getTimezonesSortedByOffset()).toEqual(['America/New_York', 'Europe/Rome']);
    } finally {
      intl.supportedValuesOf = original;
    }
  });
});
