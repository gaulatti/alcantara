import { validProgramId } from './program-id';

describe('validProgramId', () => {
  it('trims and keeps a usable id, dots and case included', () => {
    expect(validProgramId('  Station.fm ')).toBe('Station.fm');
  });

  it('refuses what is not a usable id', () => {
    for (const value of [
      undefined,
      null,
      7,
      ['main'],
      '',
      '   ',
      'a/b',
      'a\u0000b',
      'a\u007fb',
      'x'.repeat(201),
    ])
      expect(validProgramId(value)).toBeNull();
  });
});
