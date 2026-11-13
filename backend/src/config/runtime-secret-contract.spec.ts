import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  isPrivateServiceHostname,
  isValidAlanaControlToken,
  normalizeAlanaControlUrl,
  normalizePrivateServiceUrl,
  parseRuntimeSecretPayload,
  validateExternalSourceEncryption,
} from './runtime-secret-contract';

describe('runtime secret payload and private service boundaries', () => {
  const fixture = JSON.parse(
    readFileSync(
      join(__dirname, '../../test/fixtures/production-runtime-secret.json'),
      'utf8',
    ),
  );
  const key = Buffer.alloc(32, 7).toString('base64');

  it.each([
    '10.0.0.1',
    '127.0.0.1',
    '169.254.5.4',
    '172.16.0.1',
    '172.31.255.254',
    '192.168.0.1',
    '::1',
    '[::1]',
    'fc00::1',
    'fd12::1',
    'fe80::1',
    'fe90::1',
    'fea0::1',
    'feb0::1',
    'localhost',
    'recorder.localhost',
    'recorder.internal',
    'recorder.local',
    'alana',
    'ALANA.',
  ])('accepts the explicitly private service hostname %s', (host) => {
    expect(isPrivateServiceHostname(host)).toBe(true);
  });

  it.each([
    '198.51.100.1',
    '169.253.5.4',
    '172.15.255.254',
    '172.32.0.1',
    '192.169.0.1',
    '2001:db8::1',
    'fe70::1',
    'fec0::1',
    'recorder.public.example',
    '-recorder.internal',
    'recorder_.internal',
    'recorder..internal',
  ])(
    'rejects public addresses and malformed private-looking hostnames %s',
    (host) => {
      expect(isPrivateServiceHostname(host)).toBe(false);
    },
  );

  it.each([
    'not a URL',
    'http://[',
    'ftp://alana',
    'https://user@alana',
    'https://user:password@alana',
    'https://alana/path',
    'https://alana/?token=private',
    'https://alana/#fragment',
  ])(
    'rejects non-origin private service targets without returning credential/path data: %s',
    (url) => {
      expect(() => normalizePrivateServiceUrl(url, 'SERVICE_URL')).toThrow(
        'SERVICE_URL contains an invalid URL',
      );
    },
  );

  it('normalizes private targets and rejects public Alana targets', () => {
    expect(
      normalizePrivateServiceUrl('HTTP://ALANA:8080/', 'SERVICE_URL'),
    ).toBe('http://alana:8080');
    expect(normalizeAlanaControlUrl('https://[::1]:8443/')).toBe(
      'https://[::1]:8443',
    );
    expect(() => normalizeAlanaControlUrl('https://198.51.100.1')).toThrow(
      'private service hostname',
    );
    expect(() => normalizeAlanaControlUrl('https://-alana.internal')).toThrow(
      'private service hostname',
    );
  });

  it.each(
    [
      undefined,
      null,
      7,
      '',
      'A'.repeat(64),
      'a'.repeat(63),
      'a'.repeat(65),
      ` ${'a'.repeat(64)}`,
    ].map((value) => [value]),
  )('rejects malformed control bearer values (%#)', (value) => {
    expect(isValidAlanaControlToken(value as string)).toBe(false);
  });

  it('accepts only the exact lowercase hexadecimal bearer format', () => {
    expect(isValidAlanaControlToken('0123456789abcdef'.repeat(4))).toBe(true);
  });

  it.each([
    ['0', { '1': key }],
    ['-1', { '1': key }],
    ['1.5', { '1': key }],
    ['9007199254740992', { '1': key }],
    ['1', null],
    ['1', []],
    ['1', {}],
    ['2', { '1': key }],
    ['1', { '1': key, '0': key }],
    ['1', { '1': key, x: key }],
    ['1', { '1': key, '1.5': key }],
    ['1', { '1': 7 }],
    ['1', { '1': 'not-base64!' }],
    ['1', { '1': Buffer.alloc(31).toString('base64') }],
    ['1', { '1': Buffer.alloc(33).toString('base64') }],
  ])(
    'rejects malformed or incomplete versioned encryption configuration (%#)',
    (version, keys) => {
      expect(() =>
        validateExternalSourceEncryption(
          version as string,
          JSON.stringify(keys),
        ),
      ).toThrow('External source encryption configuration is malformed');
    },
  );

  it.each([undefined, '', '{'].map((value) => [value]))(
    'rejects an unreadable encryption keyring (%#)',
    (encoded) => {
      expect(() =>
        validateExternalSourceEncryption('1', encoded as string),
      ).toThrow('External source encryption configuration is malformed');
    },
  );

  it('accepts retained prior key versions while requiring the current 32-byte key', () => {
    expect(() =>
      validateExternalSourceEncryption(
        '2',
        JSON.stringify({
          '1': key,
          '2': Buffer.alloc(32, 9).toString('base64'),
        }),
      ),
    ).not.toThrow();
  });

  it.each(['{', 'null', '[]', 'false', '7', '"text"'])(
    'rejects a malformed/non-object runtime payload %s',
    (input) => {
      expect(() => parseRuntimeSecretPayload(input)).toThrow(
        'Alcantara runtime configuration is malformed',
      );
    },
  );

  it.each(
    Object.keys(fixture).flatMap((field) =>
      [null, 7, '', '   '].map((value) => [field, value]),
    ),
  )('rejects an invalid required field %s (%#)', (field, value) => {
    expect(() =>
      parseRuntimeSecretPayload(
        JSON.stringify({ ...fixture, [field as string]: value }),
      ),
    ).toThrow(`Alcantara runtime configuration field ${field} is malformed`);
  });

  it.each(Object.keys(fixture))(
    'identifies a missing required field without disclosing other values: %s',
    (field) => {
      const payload = { ...fixture };
      delete payload[field];
      expect(() => parseRuntimeSecretPayload(JSON.stringify(payload))).toThrow(
        `missing keys: ${field}`,
      );
    },
  );

  it.each([
    ['alanaControlToken', ` ${'a'.repeat(64)}`],
    ['alanaControlToken', 'DO_NOT_DISCLOSE_INVALID_BEARER'],
    ['palazzoAllowedUrls', ', ,'],
  ])(
    'rejects unsafe token/empty target-list configuration (%#)',
    (field, value) => {
      const error =
        field === 'alanaControlToken'
          ? 'ALANA_CONTROL_TOKEN is missing or invalid'
          : 'PALAZZO_ALLOWED_URLS must contain an approved URL';
      expect(() =>
        parseRuntimeSecretPayload(
          JSON.stringify({ ...fixture, [field]: value }),
        ),
      ).toThrow(error);
    },
  );

  it('selects only supported string fields and normalizes permissible surrounding whitespace', () => {
    const selected = parseRuntimeSecretPayload(
      JSON.stringify({
        ...fixture,
        palazzoAllowedUrls: ' http://palazzo:3100, , https://second.internal ',
        ignored: { nested: 'never accepted' },
      }),
    );
    expect(selected).toEqual({
      ...fixture,
      palazzoAllowedUrls: 'http://palazzo:3100, , https://second.internal',
    });
    expect(selected).not.toHaveProperty('ignored');
  });
});
