import { describe, expect, it } from 'vitest';
import { translateWorldClockCity } from './worldClockI18n';

describe('world clock city translations', () => {
  it('preserves the translations used by ToniClock', () => {
    expect(translateWorldClockCity('NEW YORK', 'es')).toBe('NUEVA YORK');
    expect(translateWorldClockCity('CAPE TOWN', 'it')).toBe('CITTÀ DEL CAPO');
  });

  it('keeps custom city labels unchanged', () => {
    expect(translateWorldClockCity('SANREMO', 'it')).toBe('SANREMO');
  });
});
