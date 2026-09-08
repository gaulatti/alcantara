import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scryptSync,
} from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export type SourceTransport = 'rtmp' | 'whip' | 'hls' | 'srt';

@Injectable()
export class ExternalSourceSecurity {
  constructor(private readonly config: ConfigService) {}

  encrypt(teamId: number, sourceId: string, value: Record<string, unknown>) {
    const { version, key } = this.currentKey();
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(Buffer.from(`alcantara-source-v1\0${teamId}\0${sourceId}`));
    const content = Buffer.concat([
      cipher.update(JSON.stringify(value)),
      cipher.final(),
      cipher.getAuthTag(),
    ]);
    return {
      ciphertext: content.toString('base64'),
      nonce: nonce.toString('base64'),
      keyVersion: version,
    };
  }

  decrypt(
    teamId: number,
    sourceId: string,
    ciphertext: string,
    nonce: string,
    version: number,
  ): Record<string, unknown> {
    const key = this.keys().get(version);
    if (!key) throw new Error('External source configuration key unavailable');
    try {
      const content = Buffer.from(ciphertext, 'base64');
      const decipher = createDecipheriv(
        'aes-256-gcm',
        key,
        Buffer.from(nonce, 'base64'),
      );
      decipher.setAAD(
        Buffer.from(`alcantara-source-v1\0${teamId}\0${sourceId}`),
      );
      decipher.setAuthTag(content.subarray(content.length - 16));
      return JSON.parse(
        Buffer.concat([
          decipher.update(content.subarray(0, content.length - 16)),
          decipher.final(),
        ]).toString('utf8'),
      ) as Record<string, unknown>;
    } catch {
      throw new Error('External source configuration is unreadable');
    }
  }

  hashCredential(secret: string): string {
    const salt = randomBytes(16);
    const digest = scryptSync(secret, salt, 32);
    return `scrypt$${salt.toString('base64')}$${digest.toString('base64')}`;
  }

  fingerprint(value: string): string {
    return createHash('sha256').update(value).digest('hex').slice(0, 16);
  }

  async validateTransportConfig(
    transport: SourceTransport,
    raw: unknown,
  ): Promise<Record<string, unknown>> {
    const config =
      raw && typeof raw === 'object' && !Array.isArray(raw)
        ? { ...(raw as Record<string, unknown>) }
        : {};
    if (transport === 'rtmp' || transport === 'whip') {
      if (Object.keys(config).length) {
        throw new BadRequestException(
          'Push sources do not accept transport URLs',
        );
      }
      return {};
    }
    if (Object.keys(config).some((key) => key !== 'url')) {
      throw new BadRequestException(
        'Transport configuration contains unsupported fields',
      );
    }
    const url = await this.validatePullUrl(config.url, transport);
    return { url };
  }

  async validatePullUrl(value: unknown, transport: 'hls' | 'srt') {
    if (typeof value !== 'string' || value.length > 2048)
      throw new BadRequestException('Source URL is invalid');
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new BadRequestException('Source URL is invalid');
    }
    const expected = transport === 'hls' ? 'https:' : 'srt:';
    if (
      url.protocol !== expected ||
      url.username ||
      url.password ||
      url.hash ||
      !url.hostname
    ) {
      throw new BadRequestException('Source URL is not permitted');
    }
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    const addresses = isIP(hostname)
      ? [{ address: hostname }]
      : await lookup(hostname, { all: true, verbatim: true }).catch(() => {
          throw new BadRequestException('Source hostname cannot be resolved');
        });
    if (
      !addresses.length ||
      addresses.some(({ address }) => unsafeAddress(address))
    ) {
      throw new BadRequestException('Source address is not permitted');
    }
    return url.toString();
  }

  private currentKey() {
    const version = Number(
      this.config.get<string>('EXTERNAL_SOURCE_CONFIG_CURRENT_VERSION'),
    );
    const key = this.keys().get(version);
    if (!Number.isSafeInteger(version) || version < 1 || !key)
      throw new Error('External source current encryption key is unavailable');
    return { version, key };
  }

  private keys(): Map<number, Buffer> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(
        this.config.get<string>('EXTERNAL_SOURCE_CONFIG_KEYS') ?? '',
      );
    } catch {
      throw new Error('External source encryption keyring is malformed');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      throw new Error('External source encryption keyring is malformed');
    const keys = new Map<number, Buffer>();
    for (const [rawVersion, encoded] of Object.entries(parsed)) {
      const version = Number(rawVersion);
      if (
        typeof encoded !== 'string' ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)
      )
        throw new Error('External source encryption keyring is malformed');
      const key = Buffer.from(encoded, 'base64');
      if (!Number.isSafeInteger(version) || version < 1 || key.length !== 32)
        throw new Error('External source encryption keyring is malformed');
      keys.set(version, key);
    }
    return keys;
  }
}

function unsafeAddress(address: string): boolean {
  if (address.includes(':')) {
    const normalized = address.toLowerCase();
    if (normalized.startsWith('::ffff:')) {
      const tail = normalized.slice('::ffff:'.length);
      if (tail.includes('.')) return unsafeAddress(tail);
      const words = tail.split(':').map((word) => Number.parseInt(word, 16));
      if (words.length === 2 && words.every((word) => Number.isInteger(word))) {
        return unsafeAddress(
          `${words[0] >> 8}.${words[0] & 255}.${words[1] >> 8}.${words[1] & 255}`,
        );
      }
      return true;
    }
    return (
      normalized === '::' ||
      normalized === '::1' ||
      normalized.startsWith('fe80:') ||
      normalized.startsWith('fc') ||
      normalized.startsWith('fd') ||
      normalized.startsWith('ff') ||
      normalized.startsWith('100:') ||
      normalized.startsWith('2001:db8:') ||
      normalized.startsWith('2001:10:') ||
      normalized.startsWith('2001:2:')
    );
  }
  const parts = address.split('.').map(Number);
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  )
    return true;
  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19 || b === 51)) ||
    (a === 203 && b === 0 && parts[2] === 113)
  );
}
