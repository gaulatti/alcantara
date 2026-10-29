/* eslint-disable @typescript-eslint/no-require-imports */
import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { lookup } from 'node:dns/promises';
import { ExternalSourceSecurity } from './external-source.security';

jest.mock('node:dns/promises', () => ({ lookup: jest.fn() }));

const lookupMock = lookup as unknown as jest.Mock;
const KEY_1 = 'YWxjYW50YXJhLWxvY2FsLXNvdXJjZS1rZXktMDAwMDA=';
const KEY_2 = Buffer.alloc(32, 7).toString('base64');

function security(values: Record<string, string | undefined> = {}) {
  return new ExternalSourceSecurity(
    new ConfigService({
      EXTERNAL_SOURCE_CONFIG_CURRENT_VERSION: '1',
      EXTERNAL_SOURCE_CONFIG_KEYS: JSON.stringify({ '1': KEY_1 }),
      ...values,
    }),
  );
}

describe('ExternalSourceSecurity coverage', () => {
  beforeEach(() => lookupMock.mockReset());

  describe('keyring handling', () => {
    it('encrypts with the configured current version and decrypts with any ring version', () => {
      const ring = JSON.stringify({ '1': KEY_1, '2': KEY_2 });
      const v2 = security({
        EXTERNAL_SOURCE_CONFIG_CURRENT_VERSION: '2',
        EXTERNAL_SOURCE_CONFIG_KEYS: ring,
      });
      const encrypted = v2.encrypt(7, 'src', { a: 1 });
      expect(encrypted.keyVersion).toBe(2);
      expect(
        v2.decrypt(7, 'src', encrypted.ciphertext, encrypted.nonce, 2),
      ).toEqual({
        a: 1,
      });
      expect(() =>
        v2.decrypt(7, 'src', encrypted.ciphertext, encrypted.nonce, 1),
      ).toThrow('External source configuration is unreadable');
    });

    it('fails when the decrypting key version is missing', () => {
      expect(() => security().decrypt(1, 's', 'AA==', 'AA==', 9)).toThrow(
        'External source configuration key unavailable',
      );
    });

    it('fails when the ciphertext is tampered with', () => {
      const s = security();
      const encrypted = s.encrypt(1, 's', { a: 1 });
      const bytes = Buffer.from(encrypted.ciphertext, 'base64');
      bytes[0] ^= 1;
      expect(() =>
        s.decrypt(1, 's', bytes.toString('base64'), encrypted.nonce, 1),
      ).toThrow('External source configuration is unreadable');
    });

    it.each([
      [
        'undefined',
        {
          EXTERNAL_SOURCE_CONFIG_CURRENT_VERSION: undefined,
        },
      ],
      [
        'a version missing from the ring',
        {
          EXTERNAL_SOURCE_CONFIG_CURRENT_VERSION: '2',
        },
      ],
      [
        'a non numeric version',
        {
          EXTERNAL_SOURCE_CONFIG_CURRENT_VERSION: 'abc',
        },
      ],
    ])('rejects encryption when the current version is %s', (_name, values) => {
      expect(() => security(values).encrypt(1, 's', {})).toThrow(
        'External source current encryption key is unavailable',
      );
    });

    it.each([
      ['unset keyring', { EXTERNAL_SOURCE_CONFIG_KEYS: undefined }],
      ['invalid JSON', { EXTERNAL_SOURCE_CONFIG_KEYS: '{' }],
      ['null', { EXTERNAL_SOURCE_CONFIG_KEYS: 'null' }],
      ['an array', { EXTERNAL_SOURCE_CONFIG_KEYS: '[]' }],
      ['a number', { EXTERNAL_SOURCE_CONFIG_KEYS: '5' }],
      ['a non string key', { EXTERNAL_SOURCE_CONFIG_KEYS: '{"1":5}' }],
      [
        'a non base64 key',
        { EXTERNAL_SOURCE_CONFIG_KEYS: '{"1":"not base64!"}' },
      ],
      ['a short key', { EXTERNAL_SOURCE_CONFIG_KEYS: '{"1":"QUJD"}' }],
      [
        'a non numeric version',
        { EXTERNAL_SOURCE_CONFIG_KEYS: JSON.stringify({ x: KEY_1 }) },
      ],
      [
        'a zero version',
        { EXTERNAL_SOURCE_CONFIG_KEYS: JSON.stringify({ '0': KEY_1 }) },
      ],
    ])('rejects a malformed keyring: %s', (_name, values) => {
      expect(() => security(values).encrypt(1, 's', {})).toThrow(
        'External source encryption keyring is malformed',
      );
    });
  });

  it('fingerprints values deterministically as 16 hex characters', () => {
    const s = security();
    expect(s.fingerprint('https://x')).toMatch(/^[0-9a-f]{16}$/);
    expect(s.fingerprint('https://x')).toBe(s.fingerprint('https://x'));
    expect(s.fingerprint('https://x')).not.toBe(s.fingerprint('https://y'));
  });

  it('formats credential hashes as scrypt$salt$digest', () => {
    expect(security().hashCredential('secret')).toMatch(
      /^scrypt\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/,
    );
  });

  describe('validateTransportConfig', () => {
    const s = security();

    it.each([null, undefined, 'x', [], [1]])(
      'treats %p as an empty config for push sources',
      async (raw) => {
        await expect(s.validateTransportConfig('rtmp', raw)).resolves.toEqual(
          {},
        );
      },
    );

    it('rejects pull configs with unsupported fields', async () => {
      await expect(
        s.validateTransportConfig('hls', { url: 'https://1.2.3.4/', extra: 1 }),
      ).rejects.toThrow(
        new BadRequestException(
          'Transport configuration contains unsupported fields',
        ),
      );
    });

    it('requires a url for pull sources', async () => {
      await expect(s.validateTransportConfig('srt', null)).rejects.toThrow(
        new BadRequestException('Source URL is invalid'),
      );
    });

    it('returns the normalized url for a valid srt source', async () => {
      await expect(
        s.validateTransportConfig('srt', { url: 'srt://93.184.216.34:9000' }),
      ).resolves.toEqual({ url: 'srt://93.184.216.34:9000' });
    });
  });

  describe('validatePullUrl', () => {
    const s = security();
    const invalid = new BadRequestException('Source URL is invalid');
    const notPermitted = new BadRequestException('Source URL is not permitted');

    it('rejects non strings, long values and unparsable urls', async () => {
      await expect(s.validatePullUrl(5, 'hls')).rejects.toThrow(invalid);
      await expect(
        s.validatePullUrl(`https://a.example/${'x'.repeat(2048)}`, 'hls'),
      ).rejects.toThrow(invalid);
      await expect(s.validatePullUrl('not a url', 'hls')).rejects.toThrow(
        invalid,
      );
    });

    it.each([
      ['wrong protocol for srt', 'https://93.184.216.34/', 'srt'],
      ['wrong protocol for hls', 'srt://93.184.216.34:9000', 'hls'],
      ['username', 'https://user@93.184.216.34/', 'hls'],
      ['password', 'https://:pw@93.184.216.34/', 'hls'],
      ['fragment', 'https://93.184.216.34/#frag', 'hls'],
      ['empty hostname', 'srt:///path', 'srt'],
    ] as const)('rejects a url with %s', async (_name, url, transport) => {
      await expect(s.validatePullUrl(url, transport)).rejects.toThrow(
        notPermitted,
      );
      expect(lookupMock).not.toHaveBeenCalled();
    });

    it('resolves hostnames and accepts public addresses', async () => {
      lookupMock.mockResolvedValue([
        { address: '93.184.216.34' },
        { address: '2606:2800:220:1:248:1893:25c8:1946' },
      ]);
      await expect(
        s.validatePullUrl('https://cdn.example.com/live.m3u8', 'hls'),
      ).resolves.toBe('https://cdn.example.com/live.m3u8');
      expect(lookupMock).toHaveBeenCalledWith('cdn.example.com', {
        all: true,
        verbatim: true,
      });
    });

    it('does not resolve IP literals and strips IPv6 brackets', async () => {
      await expect(
        s.validatePullUrl(
          'srt://[2606:2800:220:1:248:1893:25c8:1946]:9000',
          'srt',
        ),
      ).resolves.toBe('srt://[2606:2800:220:1:248:1893:25c8:1946]:9000');
      expect(lookupMock).not.toHaveBeenCalled();
    });

    it('rejects hostnames that cannot be resolved', async () => {
      lookupMock.mockRejectedValue(new Error('ENOTFOUND'));
      await expect(
        s.validatePullUrl('https://missing.example/x', 'hls'),
      ).rejects.toThrow(
        new BadRequestException('Source hostname cannot be resolved'),
      );
    });

    it('rejects an empty resolution', async () => {
      lookupMock.mockResolvedValue([]);
      await expect(
        s.validatePullUrl('https://empty.example/x', 'hls'),
      ).rejects.toThrow(
        new BadRequestException('Source address is not permitted'),
      );
    });

    const unsafe = [
      // malformed IPv4 forms
      '1.2.3',
      '1.2.3.4.5',
      'a.b.c.d',
      '1.2.3.999',
      '1.2.3.-1',
      '1.2.3.4.',
      // IPv4 reserved ranges
      '0.1.2.3',
      '10.0.0.1',
      '127.0.0.1',
      '224.0.0.1',
      '255.255.255.255',
      '100.64.0.1',
      '100.127.255.255',
      '169.254.169.254',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '192.0.2.1',
      '198.18.0.1',
      '198.19.0.1',
      '198.51.100.1',
      '203.0.113.9',
      // IPv6
      '::',
      '::1',
      'FE80::1',
      'fc00::1',
      'fd12::1',
      'ff02::1',
      '100::1',
      '2001:db8::1',
      '2001:10::1',
      '2001:2::1',
      // IPv4 mapped
      '::ffff:127.0.0.1',
      '::FFFF:7f00:1',
      '::ffff:a00:1',
      '::ffff:zz:1',
      '::ffff:1',
      '::ffff:1:2:3',
    ];

    it.each(unsafe)(
      'rejects the unsafe resolved address %s',
      async (address) => {
        lookupMock.mockResolvedValue([{ address }]);
        await expect(
          s.validatePullUrl('https://dns.example/x', 'hls'),
        ).rejects.toThrow(
          new BadRequestException('Source address is not permitted'),
        );
      },
    );

    it('rejects when any one resolved address is unsafe', async () => {
      lookupMock.mockResolvedValue([
        { address: '93.184.216.34' },
        { address: '10.1.1.1' },
      ]);
      await expect(
        s.validatePullUrl('https://dns.example/x', 'hls'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    const safe = [
      '93.184.216.34',
      '1.1.1.1',
      '100.63.255.255',
      '100.128.0.1',
      '169.253.1.1',
      '172.15.0.1',
      '172.32.0.1',
      '192.167.1.1',
      '192.1.2.3',
      '198.17.0.1',
      '198.20.0.1',
      '198.52.0.1',
      '203.1.113.1',
      '203.0.114.1',
      '223.255.255.255',
      '2606:4700::1111',
      '2001:4860:4860::8888',
      '::ffff:5db8:d822',
      '::ffff:93.184.216.34',
    ];

    it.each(safe)('accepts the public resolved address %s', async (address) => {
      lookupMock.mockResolvedValue([{ address }]);
      await expect(
        s.validatePullUrl('https://dns.example/x', 'hls'),
      ).resolves.toBe('https://dns.example/x');
    });
  });

  it('falls back to Object paramtypes when ConfigService is undefined at decoration time', () => {
    jest.isolateModules(() => {
      jest.doMock('@nestjs/config', () => ({ ConfigService: undefined }));
      const { ExternalSourceSecurity: Isolated } =
        require('./external-source.security') as {
          ExternalSourceSecurity: new (...args: never[]) => unknown;
        };
      expect(Reflect.getMetadata('design:paramtypes', Isolated)).toEqual([
        Object,
      ]);
    });
    jest.resetModules();
  });
});
