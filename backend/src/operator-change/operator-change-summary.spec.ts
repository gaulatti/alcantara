import { radioSettingsChangeSummary } from './operator-change-summary';

describe('radioSettingsChangeSummary', () => {
  it('names the fields given and keeps the value before and after of an allowlisted setting', () => {
    expect(
      radioSettingsChangeSummary(
        { enabled: false, bumperMode: 'random' },
        { enabled: true, bumperMode: 'sequential' },
        { enabled: false, bumperMode: 'random' },
      ),
    ).toEqual({
      changed: ['bumperMode', 'enabled'],
      before: { bumperMode: 'sequential', enabled: true },
      after: { bumperMode: 'random', enabled: false },
    });
  });

  it('has no before value when the program had no settings row yet', () => {
    expect(
      radioSettingsChangeSummary({ enabled: true }, null, { enabled: true }),
    ).toEqual({
      changed: ['enabled'],
      before: { enabled: null },
      after: { enabled: true },
    });
  });

  it('never copies a URL or address into the summary, only its field name', () => {
    const summary = radioSettingsChangeSummary(
      {
        palazzoUrl: 'https://palazzo.internal.example/secret-path?key=abc',
        listenerUrl: 'https://listen.example/stream?token=xyz',
      },
      {
        palazzoUrl: 'https://old.internal.example/secret-old?key=old',
        listenerUrl: 'https://old.example/stream?token=old',
      },
      {
        palazzoUrl: 'https://palazzo.internal.example/secret-path?key=abc',
        listenerUrl: 'https://listen.example/stream?token=xyz',
      },
    );
    expect(summary.changed).toEqual(['palazzoUrl', 'listenerUrl']);
    expect(summary.before).toEqual({});
    expect(summary.after).toEqual({});
    const text = JSON.stringify(summary);
    for (const leak of ['secret-path', 'secret-old', 'token=', 'key='])
      expect(text).not.toContain(leak);
  });

  it('ignores a field outside the allowlist and an unset field', () => {
    const summary = radioSettingsChangeSummary(
      { unknownField: 'x', enabled: undefined, segueMode: 'off' },
      { segueMode: 'on', unknownField: 'before' },
      { segueMode: 'off', unknownField: 'x' },
    );
    expect(summary.changed).toEqual(['segueMode']);
    expect(summary.before).toEqual({ segueMode: 'on' });
    expect(summary.after).toEqual({ segueMode: 'off' });
  });

  it('keeps an object value out of the summary, even for an allowlisted setting', () => {
    const summary = radioSettingsChangeSummary(
      { bumperInterval: { raw: 'x' } },
      { bumperInterval: { raw: 'before' } },
      { bumperInterval: { raw: 'x' } },
    );
    expect(summary.changed).toEqual(['bumperInterval']);
    expect(summary.before).toEqual({ bumperInterval: null });
    expect(summary.after).toEqual({ bumperInterval: null });
  });
});
