import {
  RUNTIME_SECRET_KEYS,
  isPrivateServiceHostname,
  isValidAlanaControlToken,
  normalizeAlanaControlUrl,
  normalizePrivateServiceUrl,
  parseRuntimeSecretPayload,
  validateExternalSourceEncryption,
} from './runtime-secret-contract';

const TOKEN = 'a'.repeat(64);
const KEY = Buffer.alloc(32, 7).toString('base64');
const KEYS = JSON.stringify({ '1': KEY });

function payload(overrides: Record<string, unknown> = {}) {
  return {
    palazzoAllowedUrls: 'http://palazzo:3100',
    alanaControlToken: TOKEN,
    alanaControlUrl: 'http://alana:8080',
    externalSourceConfigCurrentVersion: '1',
    externalSourceConfigKeys: KEYS,
    ...overrides,
  };
}

describe('runtime secret contract', () => {
  it('lists the allowlisted keys', () => {
    expect(RUNTIME_SECRET_KEYS).toEqual([
      'palazzoAllowedUrls',
      'alanaControlToken',
      'alanaControlUrl',
      'externalSourceConfigCurrentVersion',
      'externalSourceConfigKeys',
    ]);
    expect(Object.isFrozen(RUNTIME_SECRET_KEYS)).toBe(true);
  });

  describe('isValidAlanaControlToken', () => {
    it.each([
      [TOKEN, true],
      ['A'.repeat(64), false],
      ['a'.repeat(63), false],
      [undefined, false],
      [12, false],
    ])('classifies %p as %p', (value, expected) => {
      expect(isValidAlanaControlToken(value as string)).toBe(expected);
    });
  });

  describe('normalizePrivateServiceUrl', () => {
    it('returns the origin for a bare http(s) url', () => {
      expect(normalizePrivateServiceUrl('http://palazzo:3100', 'F')).toBe(
        'http://palazzo:3100',
      );
      expect(normalizePrivateServiceUrl('https://x.example/', 'F')).toBe(
        'https://x.example',
      );
    });

    it.each([
      'not a url',
      'ftp://host',
      'http://user@host',
      'http://:pw@host',
      'http://host/?q=1',
      'http://host/#frag',
      'http://host/path',
    ])('rejects %p naming the field', (value) => {
      expect(() => normalizePrivateServiceUrl(value, 'MY_FIELD')).toThrow(
        'MY_FIELD contains an invalid URL',
      );
    });
  });

  describe('isPrivateServiceHostname', () => {
    it.each([
      '10.1.2.3',
      '127.0.0.1',
      '169.254.1.1',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '::1',
      '[::1]',
      'fc00::1',
      'fd12::1',
      'fe80::1',
      'fea0::1',
      'localhost',
      'LOCALHOST.',
      'api.localhost',
      'svc.internal',
      'svc.local',
      'alana',
    ])('treats %s as private', (hostname) => {
      expect(isPrivateServiceHostname(hostname)).toBe(true);
    });

    it.each([
      '8.8.8.8',
      '172.15.0.1',
      '172.32.0.1',
      '169.253.1.1',
      '192.169.1.1',
      '11.0.0.1',
      '2001:db8::1',
      'fe00::1',
      'example.com',
      'bad_label.internal',
      '-bad.local',
      '',
    ])('treats %p as not private', (hostname) => {
      expect(isPrivateServiceHostname(hostname)).toBe(false);
    });
  });

  describe('normalizeAlanaControlUrl', () => {
    it('accepts a private service url', () => {
      expect(normalizeAlanaControlUrl('http://alana:8080')).toBe(
        'http://alana:8080',
      );
    });

    it('rejects public hosts and malformed urls', () => {
      expect(() => normalizeAlanaControlUrl('https://example.com')).toThrow(
        'ALANA_CONTROL_URL must use a private service hostname',
      );
      expect(() => normalizeAlanaControlUrl('')).toThrow(
        'ALANA_CONTROL_URL contains an invalid URL',
      );
    });
  });

  describe('validateExternalSourceEncryption', () => {
    const malformed = 'External source encryption configuration is malformed';

    it('accepts a current version present in the keyring', () => {
      expect(() => validateExternalSourceEncryption('1', KEYS)).not.toThrow();
      expect(() =>
        validateExternalSourceEncryption(
          '2',
          JSON.stringify({ '1': KEY, '2': KEY }),
        ),
      ).not.toThrow();
    });

    it.each([
      ['1', undefined],
      ['1', 'not json'],
      ['abc', KEYS],
      ['0', KEYS],
      ['1', 'null'],
      ['1', '"text"'],
      ['1', '[]'],
      ['1', '{}'],
      ['2', KEYS],
      ['1', JSON.stringify({ '1': KEY, abc: KEY })],
      ['1', JSON.stringify({ '1': KEY, '0': KEY })],
      ['1', JSON.stringify({ '1': 5 })],
      ['1', JSON.stringify({ '1': 'not base64!' })],
      ['1', JSON.stringify({ '1': Buffer.alloc(16).toString('base64') })],
    ])('rejects version %p with keys %p', (version, keys) => {
      expect(() =>
        validateExternalSourceEncryption(version, keys as string | undefined),
      ).toThrow(malformed);
    });
  });

  describe('parseRuntimeSecretPayload', () => {
    it('returns only the trimmed allowlisted fields', () => {
      const selected = parseRuntimeSecretPayload(
        JSON.stringify(
          payload({
            palazzoAllowedUrls: ' http://palazzo:3100 , http://other:3100 ',
            extra: 'dropped',
          }),
        ),
      );
      expect(selected).toEqual({
        ...payload(),
        palazzoAllowedUrls: 'http://palazzo:3100 , http://other:3100',
      });
      expect(selected).not.toHaveProperty('extra');
    });

    it.each([undefined, 'not json', 'null', '"x"', '[]', '5'])(
      'rejects malformed document %p',
      (input) => {
        expect(() => parseRuntimeSecretPayload(input)).toThrow(
          'Alcantara runtime configuration is malformed',
        );
      },
    );

    it('rejects non-string or blank allowlisted values', () => {
      expect(() =>
        parseRuntimeSecretPayload(
          JSON.stringify(payload({ alanaControlUrl: 5 })),
        ),
      ).toThrow('field alanaControlUrl is malformed');
      expect(() =>
        parseRuntimeSecretPayload(
          JSON.stringify(payload({ alanaControlUrl: '   ' })),
        ),
      ).toThrow('field alanaControlUrl is malformed');
    });

    it('rejects a control token with surrounding whitespace', () => {
      expect(() =>
        parseRuntimeSecretPayload(
          JSON.stringify(payload({ alanaControlToken: ` ${TOKEN}` })),
        ),
      ).toThrow('ALANA_CONTROL_TOKEN is missing or invalid');
    });

    it('lists missing keys', () => {
      expect(() => parseRuntimeSecretPayload('{}')).toThrow(
        `missing keys: ${RUNTIME_SECRET_KEYS.join(', ')}`,
      );
    });

    it('rejects an empty approved url list', () => {
      expect(() =>
        parseRuntimeSecretPayload(
          JSON.stringify(payload({ palazzoAllowedUrls: ' , ' })),
        ),
      ).toThrow('PALAZZO_ALLOWED_URLS must contain an approved URL');
    });

    it('rejects an invalid palazzo url, token, alana url, and keyring', () => {
      expect(() =>
        parseRuntimeSecretPayload(
          JSON.stringify(payload({ palazzoAllowedUrls: 'ftp://x' })),
        ),
      ).toThrow('PALAZZO_ALLOWED_URLS contains an invalid URL');
      expect(() =>
        parseRuntimeSecretPayload(
          JSON.stringify(payload({ alanaControlToken: 'short' })),
        ),
      ).toThrow('ALANA_CONTROL_TOKEN is missing or invalid');
      expect(() =>
        parseRuntimeSecretPayload(
          JSON.stringify(payload({ alanaControlUrl: 'https://example.com' })),
        ),
      ).toThrow('must use a private service hostname');
      expect(() =>
        parseRuntimeSecretPayload(
          JSON.stringify(payload({ externalSourceConfigKeys: '{}' })),
        ),
      ).toThrow('External source encryption configuration is malformed');
    });
  });
});
