import { ConfigService } from '@nestjs/config';
import { lookup } from 'node:dns/promises';
import { ExternalSourceSecurity } from './external-source.security';

jest.mock('node:dns/promises', () => ({ lookup: jest.fn() }));
const key1 = Buffer.alloc(32, 11).toString('base64');
const key2 = Buffer.alloc(32, 12).toString('base64');

function fixture(values: Record<string, unknown> = {}) {
  return new ExternalSourceSecurity(
    new ConfigService({
      EXTERNAL_SOURCE_CONFIG_CURRENT_VERSION: '1',
      EXTERNAL_SOURCE_CONFIG_KEYS: JSON.stringify({ 1: key1 }),
      ...values,
    }),
  );
}

describe('ExternalSourceSecurity key rotation and pull-source trust boundaries', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest
      .mocked(lookup)
      .mockResolvedValue([{ address: '93.184.216.34', family: 4 }] as never);
  });

  it('keeps old source configuration readable through a declared key rotation and encrypts new writes with the new version', () => {
    const value = {
      url: 'https://93.184.216.34/camera.m3u8',
      label: 'remote-camera',
    };
    const first = fixture().encrypt(42, 'source-a', value);
    const rotated = fixture({
      EXTERNAL_SOURCE_CONFIG_CURRENT_VERSION: '2',
      EXTERNAL_SOURCE_CONFIG_KEYS: JSON.stringify({ 1: key1, 2: key2 }),
    });
    expect(
      rotated.decrypt(
        42,
        'source-a',
        first.ciphertext,
        first.nonce,
        first.keyVersion,
      ),
    ).toEqual(value);
    const second = rotated.encrypt(42, 'source-a', value);
    expect(second.keyVersion).toBe(2);
    expect(
      rotated.decrypt(
        42,
        'source-a',
        second.ciphertext,
        second.nonce,
        second.keyVersion,
      ),
    ).toEqual(value);
    expect(() =>
      fixture().decrypt(42, 'source-a', second.ciphertext, second.nonce, 2),
    ).toThrow('configuration key unavailable');
  });

  it.each([
    undefined,
    '',
    '{',
    'null',
    'false',
    '12',
    '"keyring"',
    '[]',
    '{"1":null}',
    '{"1":42}',
    '{"1":""}',
    '{"1":"*not-base64*"}',
    JSON.stringify({ 1: Buffer.alloc(31).toString('base64') }),
    JSON.stringify({ 1: Buffer.alloc(33).toString('base64') }),
    JSON.stringify({ 0: key1 }),
    JSON.stringify({ '-1': key1 }),
    JSON.stringify({ '1.5': key1 }),
    JSON.stringify({ Infinity: key1 }),
    JSON.stringify({ '9007199254740992': key1 }),
  ])(
    'rejects malformed or noncanonical keyring configuration %j before writing ciphertext',
    (keyring) => {
      expect(() =>
        fixture({ EXTERNAL_SOURCE_CONFIG_KEYS: keyring }).encrypt(
          1,
          'source-a',
          {},
        ),
      ).toThrow('encryption keyring is malformed');
    },
  );

  it.each(['0', '-1', '1.5', 'invalid', '2', '9007199254740992'])(
    'requires the current version %s to be a present positive safe-integer key',
    (version) => {
      expect(() =>
        fixture({ EXTERNAL_SOURCE_CONFIG_CURRENT_VERSION: version }).encrypt(
          1,
          'source-a',
          {},
        ),
      ).toThrow('current encryption key is unavailable');
    },
  );

  it('refuses to encrypt from an empty declared keyring', () => {
    expect(() =>
      fixture({ EXTERNAL_SOURCE_CONFIG_KEYS: '{}' }).encrypt(1, 'source-a', {}),
    ).toThrow('current encryption key is unavailable');
  });

  it('rejects malformed ciphertext, nonce and GCM authentication without disclosing content', () => {
    const security = fixture();
    const encrypted = security.encrypt(1, 'source-a', {
      url: 'https://93.184.216.34/private-feed',
    });
    for (const [ciphertext, nonce] of [
      ['', encrypted.nonce],
      [encrypted.ciphertext, 'not-a-valid-nonce'],
      [Buffer.alloc(40).toString('base64'), encrypted.nonce],
    ])
      expect(() =>
        security.decrypt(1, 'source-a', ciphertext, nonce, 1),
      ).toThrow('External source configuration is unreadable');
  });

  it.each([null, undefined, [], 'not-an-object', 42].map((raw) => [raw]))(
    'does not accept configuration fields from a nonobject pull payload %j',
    async (raw) => {
      await expect(
        fixture().validateTransportConfig('hls', raw),
      ).rejects.toThrow('Source URL is invalid');
    },
  );

  it.each(['rtmp', 'whip'] as const)(
    'allows an empty %s push configuration without looking up a target',
    async (transport) => {
      await expect(
        fixture().validateTransportConfig(transport, null),
      ).resolves.toEqual({});
      expect(lookup).not.toHaveBeenCalled();
    },
  );

  it('rejects unknown pull fields instead of allowing hidden credential or redirect settings', async () => {
    await expect(
      fixture().validateTransportConfig('hls', {
        url: 'https://93.184.216.34/feed',
        redirect: 'https://127.0.0.1',
      }),
    ).rejects.toThrow('unsupported fields');
    expect(lookup).not.toHaveBeenCalled();
  });

  it.each([
    undefined,
    null,
    42,
    '',
    'not a URL',
    `https://93.184.216.34/${'a'.repeat(2048)}`,
  ])('rejects invalid or oversized pull URL %j', async (value) => {
    await expect(fixture().validatePullUrl(value, 'hls')).rejects.toThrow(
      'Source URL is invalid',
    );
  });

  it.each([
    ['hls', 'http://93.184.216.34/feed'],
    ['hls', 'https://user@93.184.216.34/feed'],
    ['hls', 'https://:password@93.184.216.34/feed'],
    ['hls', 'https://93.184.216.34/feed#fragment'],
    ['srt', 'https://93.184.216.34/feed'],
    ['srt', 'srt:/missing-host'],
  ] as const)(
    'rejects an unauthorized %s URL shape %s',
    async (transport, value) => {
      await expect(fixture().validatePullUrl(value, transport)).rejects.toThrow(
        'Source URL is not permitted',
      );
    },
  );

  it('resolves all DNS addresses with verbatim ordering and preserves the producer URL path and query', async () => {
    const value = 'https://camera.example.invalid/live/feed.m3u8?stream=main';
    await expect(fixture().validatePullUrl(value, 'hls')).resolves.toBe(value);
    expect(lookup).toHaveBeenCalledWith('camera.example.invalid', {
      all: true,
      verbatim: true,
    });
  });

  it.each(
    [
      [],
      [
        { address: '93.184.216.34', family: 4 },
        { address: '127.0.0.1', family: 4 },
      ],
      [
        { address: '10.0.0.1', family: 4 },
        { address: '93.184.216.34', family: 4 },
      ],
    ].map((addresses) => [addresses]),
  )(
    'rejects an empty or mixed public/private DNS result %j',
    async (addresses) => {
      jest.mocked(lookup).mockResolvedValue(addresses as never);
      await expect(
        fixture().validatePullUrl('https://camera.example.invalid/feed', 'hls'),
      ).rejects.toThrow('Source address is not permitted');
    },
  );

  it('sanitizes resolver failures without exposing the resolver diagnostic', async () => {
    jest
      .mocked(lookup)
      .mockRejectedValue(new Error('private resolver diagnostic'));
    await expect(
      fixture().validatePullUrl('https://camera.example.invalid/feed', 'hls'),
    ).rejects.toThrow('Source hostname cannot be resolved');
  });

  it.each([
    '0.1.2.3',
    '10.1.2.3',
    '127.2.3.4',
    '224.1.2.3',
    '100.64.0.1',
    '100.127.255.254',
    '169.254.1.2',
    '172.16.0.1',
    '172.31.255.254',
    '192.168.0.1',
    '192.0.1.2',
    '198.18.0.1',
    '198.19.255.254',
    '198.51.100.1',
    '203.0.113.1',
    '[::]',
    '[::1]',
    '[fe80::1]',
    '[fc00::1]',
    '[fd00::1]',
    '[ff02::1]',
    '[100::1]',
    '[2001:db8::1]',
    '[2001:10::1]',
    '[2001:2::1]',
    '[::ffff:127.0.0.1]',
  ])(
    'rejects a private, special-use or documentation target %s before streaming',
    async (host) => {
      await expect(
        fixture().validatePullUrl(`https://${host}/feed`, 'hls'),
      ).rejects.toThrow('Source address is not permitted');
      expect(lookup).not.toHaveBeenCalled();
    },
  );

  it.each([
    '93.184.216.34',
    '100.63.255.254',
    '100.128.0.1',
    '169.253.0.1',
    '172.15.255.254',
    '172.32.0.1',
    '192.1.0.1',
    '192.167.0.1',
    '198.17.0.1',
    '198.20.0.1',
    '198.50.0.1',
    '198.52.0.1',
    '203.0.112.1',
    '203.0.114.1',
    '[2001:4860:4860::8888]',
    '[::ffff:93.184.216.34]',
  ])(
    'keeps public address boundary %s available to valid SRT sources',
    async (host) => {
      const value = `srt://${host}:9000?streamid=main`;
      await expect(
        fixture().validateTransportConfig('srt', { url: value }),
      ).resolves.toEqual({ url: new URL(value).toString() });
      expect(lookup).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['::ffff:127.0.0.1', false],
    ['::ffff:93.184.216.34', true],
    ['::ffff:bad-input', false],
    ['::ffff:1:2:3', false],
    ['300.1.2.3', false],
    ['1.2.3', false],
    ['1.-1.2.3', false],
  ] as const)(
    'validates address data from the resolver: %s',
    async (address, permitted) => {
      jest
        .mocked(lookup)
        .mockResolvedValue([
          { address, family: address.includes(':') ? 6 : 4 },
        ] as never);
      const result = fixture().validatePullUrl(
        'https://camera.example.invalid/feed',
        'hls',
      );
      if (permitted)
        await expect(result).resolves.toBe(
          'https://camera.example.invalid/feed',
        );
      else
        await expect(result).rejects.toThrow('Source address is not permitted');
    },
  );
});
