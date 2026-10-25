import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadDatabaseSecret } from './database-secrets';
import {
  loadRuntimeSecrets,
  validateAlanaRuntimeConfiguration,
  validateExternalSourceEncryption,
  validatePalazzoRuntimeConfiguration,
} from './runtime-secrets';
import { parseRuntimeSecretPayload } from './runtime-secret-contract';

const mockSend = jest.fn();
jest.mock('@aws-sdk/client-secrets-manager', () => ({
  ...jest.requireActual('@aws-sdk/client-secrets-manager'),
  SecretsManagerClient: jest
    .fn()
    .mockImplementation(() => ({ send: mockSend })),
}));

const databasePayload = {
  username: 'fixture-user',
  password: 'fixture-only-password',
  host: 'database.fixture.invalid',
  port: 5432,
  dbname: 'fixture',
};
const token = 'a'.repeat(64);
const keys = JSON.stringify({ '1': Buffer.alloc(32, 4).toString('base64') });
const runtimePayload = {
  palazzoAllowedUrls: 'http://palazzo:3100',
  alanaControlToken: token,
  alanaControlUrl: 'http://alana:8080',
  externalSourceConfigCurrentVersion: '1',
  externalSourceConfigKeys: keys,
};

describe('configuration bootstrap public failure boundaries', () => {
  const originalEnvironment = process.env;
  beforeEach(() => {
    jest.clearAllMocks();
    mockSend.mockReset();
  });
  afterEach(() => {
    process.env = originalEnvironment;
  });

  it('rejects absent, unreadable and non-object provider payloads without replacing explicit database configuration', async () => {
    for (const SecretString of [undefined, '{', 'null', '[]']) {
      const environment = {
        ARAUCO_SECRET_ID: 'fixture/reference',
        AWS_REGION: 'us-east-1',
        DATABASE_URL: 'postgresql://unchanged.fixture.invalid/local',
      };
      await expect(
        loadDatabaseSecret(environment, {
          send: jest.fn().mockResolvedValue({ SecretString }),
        }),
      ).rejects.toThrow('Arauco database configuration is malformed');
      expect(environment.DATABASE_URL).toBe(
        'postgresql://unchanged.fixture.invalid/local',
      );
    }
    expect(() => parseRuntimeSecretPayload(undefined)).toThrow(
      'Alcantara runtime configuration is malformed',
    );
  });

  it('requires a region before constructing a database client and supports AWS_DEFAULT_REGION for its normal SDK path', async () => {
    await expect(
      loadDatabaseSecret({ ARAUCO_SECRET_ID: 'fixture/reference' }),
    ).rejects.toThrow('AWS_REGION is required');
    expect(SecretsManagerClient).not.toHaveBeenCalled();
    mockSend.mockResolvedValue({
      SecretString: JSON.stringify(databasePayload),
    });
    const environment: NodeJS.ProcessEnv = {
      ARAUCO_SECRET_ID: 'fixture/reference',
      AWS_DEFAULT_REGION: ' us-west-2 ',
    };
    await loadDatabaseSecret(environment);
    expect(SecretsManagerClient).toHaveBeenCalledWith({ region: 'us-west-2' });
    expect(mockSend.mock.calls[0][0].input).toEqual({
      SecretId: 'fixture/reference',
    });
    expect(new URL(environment.DATABASE_URL!).hostname).toBe(
      databasePayload.host,
    );
    expect(new URL(environment.DATABASE_URL!).searchParams.get('sslmode')).toBe(
      'verify-full',
    );
  });

  it('redacts a real missing token-file platform error during production bootstrap', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'alcantara-config-boundary-'));
    try {
      await expect(
        loadRuntimeSecrets({
          NODE_ENV: 'production',
          ALANA_CONTROL_TOKEN_FILE: join(directory, 'missing-token'),
        }),
      ).rejects.toThrow('Alcantara runtime configuration is unavailable');
      expect(SecretsManagerClient).not.toHaveBeenCalled();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('validates the normal process environment while rejecting absent Alana credentials and origin', () => {
    process.env = {
      PALAZZO_ALLOWED_URLS: 'http://palazzo:3100',
      ALANA_CONTROL_TOKEN: token,
      ALANA_CONTROL_URL: 'http://alana:8080',
      EXTERNAL_SOURCE_CONFIG_CURRENT_VERSION: '1',
      EXTERNAL_SOURCE_CONFIG_KEYS: keys,
    };
    expect(() => validatePalazzoRuntimeConfiguration()).not.toThrow();
    expect(() => validateAlanaRuntimeConfiguration()).not.toThrow();
    expect(() => validateExternalSourceEncryption()).not.toThrow();
    expect(() => validateAlanaRuntimeConfiguration({})).toThrow(
      'ALANA_CONTROL_TOKEN is missing or invalid',
    );
    expect(() =>
      validateAlanaRuntimeConfiguration({ ALANA_CONTROL_TOKEN: token }),
    ).toThrow('ALANA_CONTROL_URL contains an invalid URL');
  });

  it('requires a production runtime region before client creation and honors the default-region SDK route', async () => {
    await expect(
      loadRuntimeSecrets({
        NODE_ENV: 'production',
        ALCANTARA_CONFIG_SECRET_ID: 'fixture/runtime',
      }),
    ).rejects.toThrow('AWS_REGION is required');
    expect(SecretsManagerClient).not.toHaveBeenCalled();
    mockSend.mockResolvedValue({
      SecretString: JSON.stringify(runtimePayload),
    });
    const environment: NodeJS.ProcessEnv = {
      NODE_ENV: 'production',
      ALCANTARA_CONFIG_SECRET_ID: 'fixture/runtime',
      AWS_DEFAULT_REGION: ' us-west-2 ',
    };
    await loadRuntimeSecrets(environment);
    expect(SecretsManagerClient).toHaveBeenCalledWith({ region: 'us-west-2' });
    expect(mockSend.mock.calls[0][0].input).toEqual({
      SecretId: 'fixture/runtime',
    });
    expect(environment.ALANA_CONTROL_URL).toBe(runtimePayload.alanaControlUrl);
    expect(environment.EXTERNAL_SOURCE_CONFIG_KEYS).toBe(keys);
  });
});
