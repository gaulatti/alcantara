import { artistKey } from './artist-key';

describe('artistKey', () => {
  it('ignores case and outer spaces and nothing else', () => {
    expect(artistKey('  ROB ')).toBe('rob');
    expect(artistKey('Rob')).toBe(artistKey('rob'));
    expect(artistKey('Rob  Roy')).toBe('rob  roy');
    expect(artistKey('Rob & Roy')).not.toBe(artistKey('Rob and Roy'));
  });
});
