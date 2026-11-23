import { radioSettingsChangeSummary } from './operator-change-summary';

describe('radioSettingsChangeSummary', () => {
  it('names the fields given and keeps the new value of an allowlisted setting', () => {
    expect(
      radioSettingsChangeSummary({ enabled: false, bumperMode: 'random' }),
    ).toEqual({
      changed: ['bumperMode', 'enabled'],
      values: { enabled: false, bumperMode: 'random' },
    });
  });

  it('never copies a URL or address into the summary, only its field name', () => {
    const summary = radioSettingsChangeSummary({
      palazzoUrl: 'https://palazzo.internal.example/secret-path?key=abc',
      listenerUrl: 'https://listen.example/stream?token=xyz',
    });
    expect(summary.changed).toEqual(['palazzoUrl', 'listenerUrl']);
    expect(summary.values).toEqual({});
    expect(JSON.stringify(summary)).not.toContain('secret-path');
    expect(JSON.stringify(summary)).not.toContain('token=');
  });

  it('ignores a field outside the allowlist and an unset field', () => {
    const summary = radioSettingsChangeSummary({
      unknownField: 'x',
      enabled: undefined,
      segueMode: 'off',
    });
    expect(summary.changed).toEqual(['segueMode']);
    expect(summary.values).toEqual({ segueMode: 'off' });
  });

  it('keeps an object value out of the values, even for an allowlisted setting', () => {
    const summary = radioSettingsChangeSummary({
      bumperInterval: { raw: 'x' },
    });
    expect(summary.values).toEqual({});
    expect(summary.changed).toEqual(['bumperInterval']);
  });
});
