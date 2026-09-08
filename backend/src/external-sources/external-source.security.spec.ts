import { ConfigService } from '@nestjs/config';
import { ExternalSourceSecurity } from './external-source.security';

const keyring = '{"1":"YWxjYW50YXJhLWxvY2FsLXNvdXJjZS1rZXktMDAwMDA="}';

describe('ExternalSourceSecurity', () => {
  const security = new ExternalSourceSecurity(
    new ConfigService({
      EXTERNAL_SOURCE_CONFIG_CURRENT_VERSION: '1',
      EXTERNAL_SOURCE_CONFIG_KEYS: keyring,
    }),
  );

  it('uses authenticated tenant/source-bound encryption with unique nonces', () => {
    const value = { url: 'https://93.184.216.34/feed.m3u8' };
    const first = security.encrypt(1, 'source-a', value);
    const second = security.encrypt(1, 'source-a', value);
    expect(first.ciphertext).not.toBe(second.ciphertext);
    expect(first.nonce).not.toBe(second.nonce);
    expect(first.ciphertext).not.toContain(value.url);
    expect(
      security.decrypt(1, 'source-a', first.ciphertext, first.nonce, 1),
    ).toEqual(value);
    expect(() =>
      security.decrypt(2, 'source-a', first.ciphertext, first.nonce, 1),
    ).toThrow('unreadable');
    expect(() =>
      security.decrypt(1, 'source-b', first.ciphertext, first.nonce, 1),
    ).toThrow('unreadable');
  });

  it('hashes one-time credentials without retaining their value', () => {
    const secret = 'one-time-publisher-secret';
    const first = security.hashCredential(secret);
    const second = security.hashCredential(secret);
    expect(first).not.toBe(second);
    expect(first).not.toContain(secret);
  });

  it('rejects unsafe pull URLs, credentials, schemes, and redirect targets', async () => {
    await expect(
      security.validateTransportConfig('hls', {
        url: 'https://127.0.0.1/private.m3u8',
      }),
    ).rejects.toThrow('not permitted');
    await expect(
      security.validateTransportConfig('hls', {
        url: 'https://user:password@93.184.216.34/feed.m3u8',
      }),
    ).rejects.toThrow('not permitted');
    await expect(
      security.validateTransportConfig('hls', {
        url: 'http://93.184.216.34/feed.m3u8',
      }),
    ).rejects.toThrow('not permitted');
    await expect(
      security.validatePullUrl('srt://169.254.169.254:9000', 'srt'),
    ).rejects.toThrow('not permitted');
    await expect(
      security.validatePullUrl('srt://[::ffff:127.0.0.1]:9000', 'srt'),
    ).rejects.toThrow('not permitted');
    await expect(
      security.validateTransportConfig('hls', {
        url: 'https://93.184.216.34/feed.m3u8',
      }),
    ).resolves.toEqual({ url: 'https://93.184.216.34/feed.m3u8' });
  });

  it('rejects transport fields for one-time push credentials', async () => {
    await expect(
      security.validateTransportConfig('whip', { url: 'https://example.com' }),
    ).rejects.toThrow('do not accept');
    await expect(security.validateTransportConfig('rtmp', {})).resolves.toEqual(
      {},
    );
  });
});
