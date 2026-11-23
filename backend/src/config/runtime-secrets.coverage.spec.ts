import { readFile } from 'node:fs/promises';
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import {
  DEFAULT_PRODUCTION_TEMPLATE_ORIGINS,
  getApprovedTemplateOrigins,
} from '../program/program-template.service';
import {
  loadRuntimeSecrets,
  normalizePalazzoBaseUrl,
  normalizePrivateServiceUrl,
  validateAlanaRuntimeConfiguration,
  validateExternalSourceEncryption,
  validatePalazzoRuntimeConfiguration,
  validateRuntimeConfiguration,
} from './runtime-secrets';

jest.mock('node:fs/promises', () => ({ readFile: jest.fn() }));
jest.mock('@aws-sdk/client-secrets-manager', () => ({
  GetSecretValueCommand: jest.fn().mockImplementation((input: unknown) => ({
    input,
  })),
  SecretsManagerClient: jest.fn(),
}));

const readFileMock = jest.mocked(readFile);
const TOKEN = 'b'.repeat(64);
const KEYS = JSON.stringify({ '1': Buffer.alloc(32, 3).toString('base64') });

function validEnvironment(extra: Record<string, string> = {}) {
  return {
    PALAZZO_ALLOWED_URLS: 'http://palazzo:3100',
    ALANA_CONTROL_TOKEN: TOKEN,
    ALANA_CONTROL_URL: 'http://alana:8080',
    EXTERNAL_SOURCE_CONFIG_CURRENT_VERSION: '1',
    EXTERNAL_SOURCE_CONFIG_KEYS: KEYS,
    ...extra,
  };
}

function secretString() {
  return JSON.stringify({
    palazzoAllowedUrls: 'http://palazzo:3100',
    alanaControlToken: TOKEN,
    alanaControlUrl: 'http://alana:8080',
    externalSourceConfigCurrentVersion: '1',
    externalSourceConfigKeys: KEYS,
  });
}

describe('runtime-secrets coverage', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('re-exports and applies the palazzo normalizer', () => {
    expect(normalizePalazzoBaseUrl('http://palazzo:3100/')).toBe(
      'http://palazzo:3100',
    );
    expect(() => normalizePalazzoBaseUrl('ftp://x')).toThrow(
      'PALAZZO_ALLOWED_URLS contains an invalid URL',
    );
    expect(normalizePrivateServiceUrl('http://a:1', 'F')).toBe('http://a:1');
  });

  describe('validatePalazzoRuntimeConfiguration', () => {
    it('requires at least one approved url', () => {
      expect(() => validatePalazzoRuntimeConfiguration({})).toThrow(
        'PALAZZO_ALLOWED_URLS must contain an approved URL',
      );
      expect(() =>
        validatePalazzoRuntimeConfiguration({ PALAZZO_ALLOWED_URLS: ' , ' }),
      ).toThrow('PALAZZO_ALLOWED_URLS must contain an approved URL');
    });

    it('accepts a list and defaults to process.env', () => {
      expect(() =>
        validatePalazzoRuntimeConfiguration({
          PALAZZO_ALLOWED_URLS: 'http://a:1, http://b:2',
        }),
      ).not.toThrow();
      process.env.PALAZZO_ALLOWED_URLS = 'http://c:3';
      expect(() => validatePalazzoRuntimeConfiguration()).not.toThrow();
      delete process.env.PALAZZO_ALLOWED_URLS;
      expect(() => validatePalazzoRuntimeConfiguration()).toThrow(
        'must contain an approved URL',
      );
    });
  });

  describe('validateAlanaRuntimeConfiguration', () => {
    it('rejects a missing token and a missing url', () => {
      expect(() => validateAlanaRuntimeConfiguration({})).toThrow(
        'ALANA_CONTROL_TOKEN is missing or invalid',
      );
      expect(() =>
        validateAlanaRuntimeConfiguration({ ALANA_CONTROL_TOKEN: TOKEN }),
      ).toThrow('ALANA_CONTROL_URL contains an invalid URL');
    });

    it('trims the url and defaults to process.env', () => {
      expect(() =>
        validateAlanaRuntimeConfiguration({
          ALANA_CONTROL_TOKEN: TOKEN,
          ALANA_CONTROL_URL: ' http://alana:8080 ',
        }),
      ).not.toThrow();
      process.env.ALANA_CONTROL_TOKEN = TOKEN;
      process.env.ALANA_CONTROL_URL = 'http://alana:8080';
      expect(() => validateAlanaRuntimeConfiguration()).not.toThrow();
    });
  });

  describe('validateRuntimeConfiguration and external source validation', () => {
    it('validates every section', () => {
      expect(() =>
        validateRuntimeConfiguration(validEnvironment()),
      ).not.toThrow();
      expect(() =>
        validateRuntimeConfiguration(
          validEnvironment({ EXTERNAL_SOURCE_CONFIG_KEYS: '{}' }),
        ),
      ).toThrow('External source encryption configuration is malformed');
    });

    it('defaults to process.env', () => {
      Object.assign(process.env, validEnvironment());
      expect(() => validateRuntimeConfiguration()).not.toThrow();
      expect(() => validateExternalSourceEncryption()).not.toThrow();
      delete process.env.EXTERNAL_SOURCE_CONFIG_KEYS;
      expect(() => validateExternalSourceEncryption()).toThrow('malformed');
    });
  });

  describe('loadRuntimeSecrets', () => {
    it('is a no-op outside production, defaulting to process.env', async () => {
      process.env.NODE_ENV = 'development';
      await expect(loadRuntimeSecrets()).resolves.toBeUndefined();
      expect(readFileMock).not.toHaveBeenCalled();
    });

    it('requires a secret id or a token file in production', async () => {
      await expect(
        loadRuntimeSecrets({
          NODE_ENV: 'production',
          ALCANTARA_CONFIG_SECRET_ID: '  ',
        }),
      ).rejects.toThrow(
        'ALCANTARA_CONFIG_SECRET_ID or ALANA_CONTROL_TOKEN_FILE is required',
      );
      await expect(
        loadRuntimeSecrets({
          NODE_ENV: 'production',
          ALANA_CONTROL_TOKEN_FILE: ' ',
        }),
      ).rejects.toThrow('is required');
    });

    it('reads the token file, strips one trailing CRLF, then validates', async () => {
      readFileMock.mockResolvedValueOnce(`${TOKEN}\r\n` as never);
      const environment = validEnvironment({
        NODE_ENV: 'production',
        ALANA_CONTROL_TOKEN_FILE: ' /run/token ',
      });
      delete (environment as Record<string, string>).ALANA_CONTROL_TOKEN;
      await loadRuntimeSecrets(environment);
      expect(readFileMock).toHaveBeenCalledWith('/run/token', 'utf8');
      expect((environment as Record<string, string>).ALANA_CONTROL_TOKEN).toBe(
        TOKEN,
      );
    });

    it('hides read failures behind a generic unavailable error', async () => {
      readFileMock.mockRejectedValueOnce(new Error('ENOENT secret/path'));
      await expect(
        loadRuntimeSecrets({
          NODE_ENV: 'production',
          ALANA_CONTROL_TOKEN_FILE: '/run/token',
        }),
      ).rejects.toThrow(/^Alcantara runtime configuration is unavailable$/);
    });

    it('fails validation after reading an invalid token file', async () => {
      readFileMock.mockResolvedValueOnce('short' as never);
      await expect(
        loadRuntimeSecrets({
          NODE_ENV: 'production',
          ALANA_CONTROL_TOKEN_FILE: '/run/token',
          PALAZZO_ALLOWED_URLS: 'http://palazzo:3100',
        }),
      ).rejects.toThrow('ALANA_CONTROL_TOKEN is missing or invalid');
    });

    it('requires a region when a secret id is configured', async () => {
      await expect(
        loadRuntimeSecrets(
          {
            NODE_ENV: 'production',
            ALCANTARA_CONFIG_SECRET_ID: 'id',
            AWS_REGION: ' ',
          },
          { send: jest.fn() },
        ),
      ).rejects.toThrow('AWS_REGION is required');
    });

    it('prefers AWS_REGION, falls back to AWS_DEFAULT_REGION, and builds the default client', async () => {
      const send = jest
        .fn()
        .mockResolvedValue({ SecretString: secretString() });
      jest
        .mocked(SecretsManagerClient)
        .mockImplementation(
          () => ({ send }) as unknown as SecretsManagerClient,
        );
      const environment: Record<string, string> = {
        NODE_ENV: 'production',
        ALCANTARA_CONFIG_SECRET_ID: ' secret-id ',
        AWS_DEFAULT_REGION: 'eu-west-1',
      };
      await loadRuntimeSecrets(environment);
      expect(SecretsManagerClient).toHaveBeenCalledWith({
        region: 'eu-west-1',
      });
      expect(GetSecretValueCommand).toHaveBeenCalledWith({
        SecretId: 'secret-id',
      });
      expect(send).toHaveBeenCalledTimes(1);
      expect(environment).toMatchObject(validEnvironment());

      jest.mocked(SecretsManagerClient).mockClear();
      await loadRuntimeSecrets({
        NODE_ENV: 'production',
        ALCANTARA_CONFIG_SECRET_ID: 'secret-id',
        AWS_REGION: 'us-east-2',
        AWS_DEFAULT_REGION: 'eu-west-1',
      });
      expect(SecretsManagerClient).toHaveBeenCalledWith({
        region: 'us-east-2',
      });
    });

    it('hides provider failures and rejects malformed payloads', async () => {
      const base = {
        NODE_ENV: 'production',
        ALCANTARA_CONFIG_SECRET_ID: 'id',
        AWS_REGION: 'us-east-1',
      };
      await expect(
        loadRuntimeSecrets(base, {
          send: jest.fn().mockRejectedValue(new Error('AccessDenied arn:aws')),
        }),
      ).rejects.toThrow(/^Alcantara runtime configuration is unavailable$/);
      await expect(
        loadRuntimeSecrets(base, {
          send: jest.fn().mockResolvedValue({}),
        }),
      ).rejects.toThrow('runtime configuration is malformed');

      const envWithOrigins: Record<string, string> = {
        NODE_ENV: 'production',
        ALCANTARA_CONFIG_SECRET_ID: 'id',
        AWS_REGION: 'us-east-1',
      };
      await loadRuntimeSecrets(envWithOrigins, {
        send: jest.fn().mockResolvedValue({
          SecretString: JSON.stringify({
            palazzoAllowedUrls: 'http://palazzo:3100',
            alanaControlToken: TOKEN,
            alanaControlUrl: 'http://alana:8080',
            externalSourceConfigCurrentVersion: '1',
            externalSourceConfigKeys: KEYS,
            programTemplateOrigins: 'https://template.harborlight.test',
          }),
        }),
      });
      expect(envWithOrigins.PROGRAM_TEMPLATE_ORIGINS).toBe(
        'https://template.harborlight.test',
      );
    });
  });

  describe('POMPEII_ACCESS_CREDENTIAL: optional, and the secret is authoritative in production', () => {
    const CREDENTIAL = `pmp_svc_${'c'.repeat(43)}`;
    const load = async (
      credential: unknown,
      environment: Record<string, string>,
    ) =>
      loadRuntimeSecrets(
        {
          NODE_ENV: 'production',
          ALCANTARA_CONFIG_SECRET_ID: 'id',
          AWS_REGION: 'us-east-1',
          ...environment,
        },
        {
          send: jest.fn().mockResolvedValue({
            SecretString: JSON.stringify({
              ...JSON.parse(secretString()),
              ...(credential === undefined
                ? {}
                : { POMPEII_ACCESS_CREDENTIAL: credential }),
            }),
          }),
        },
      );

    it('loads the credential from the secret into the process environment', async () => {
      const environment: Record<string, string> = {
        NODE_ENV: 'production',
        ALCANTARA_CONFIG_SECRET_ID: 'id',
        AWS_REGION: 'us-east-1',
      };
      await loadRuntimeSecrets(environment, {
        send: jest.fn().mockResolvedValue({
          SecretString: JSON.stringify({
            ...JSON.parse(secretString()),
            POMPEII_ACCESS_CREDENTIAL: ` ${CREDENTIAL} `,
          }),
        }),
      });
      expect(environment.POMPEII_ACCESS_CREDENTIAL).toBe(CREDENTIAL);
    });

    it('does not fail startup when the key is absent or blank, and drops a leftover', async () => {
      for (const credential of [undefined, '', '  ']) {
        const environment: Record<string, string> = {
          NODE_ENV: 'production',
          ALCANTARA_CONFIG_SECRET_ID: 'id',
          AWS_REGION: 'us-east-1',
          POMPEII_ACCESS_CREDENTIAL: 'leftover',
        };
        await expect(
          loadRuntimeSecrets(environment, {
            send: jest.fn().mockResolvedValue({
              SecretString: JSON.stringify({
                ...JSON.parse(secretString()),
                ...(credential === undefined
                  ? {}
                  : { POMPEII_ACCESS_CREDENTIAL: credential }),
              }),
            }),
          }),
        ).resolves.toBeUndefined();
        expect(environment.POMPEII_ACCESS_CREDENTIAL).toBeUndefined();
      }
    });

    it('fails startup on a malformed value without echoing it', async () => {
      await expect(load(12345, {})).rejects.toThrow(
        'Alcantara runtime configuration field POMPEII_ACCESS_CREDENTIAL is malformed',
      );
    });

    it('keeps the local environment value outside production', async () => {
      const environment: Record<string, string> = {
        NODE_ENV: 'development',
        POMPEII_ACCESS_CREDENTIAL: CREDENTIAL,
      };
      await loadRuntimeSecrets(environment);
      expect(environment.POMPEII_ACCESS_CREDENTIAL).toBe(CREDENTIAL);
    });
  });

  describe('template origins: the secret is authoritative in production', () => {
    it('drops a leftover PROGRAM_TEMPLATE_ORIGINS when the production secret omits the key', async () => {
      const environment: Record<string, string> = {
        NODE_ENV: 'production',
        ALCANTARA_CONFIG_SECRET_ID: 'id',
        AWS_REGION: 'us-east-1',
        PROGRAM_TEMPLATE_ORIGINS: 'https://leftover.harborlight.test',
      };
      await loadRuntimeSecrets(environment, {
        send: jest.fn().mockResolvedValue({ SecretString: secretString() }),
      });
      expect(environment.PROGRAM_TEMPLATE_ORIGINS).toBeUndefined();
      expect(getApprovedTemplateOrigins(environment)).toEqual(
        new Set(DEFAULT_PRODUCTION_TEMPLATE_ORIGINS),
      );
    });

    it('keeps the local environment value outside production', async () => {
      const environment: Record<string, string> = {
        NODE_ENV: 'development',
        PROGRAM_TEMPLATE_ORIGINS: 'https://local.harborlight.test',
      };
      await loadRuntimeSecrets(environment);
      expect(environment.PROGRAM_TEMPLATE_ORIGINS).toBe(
        'https://local.harborlight.test',
      );
      expect(getApprovedTemplateOrigins(environment)).toEqual(
        new Set([
          ...DEFAULT_PRODUCTION_TEMPLATE_ORIGINS,
          'https://local.harborlight.test',
        ]),
      );
    });
  });

  describe('validateRuntimeConfiguration with template origins', () => {
    it('validates PROGRAM_TEMPLATE_ORIGINS when present', () => {
      expect(() =>
        validateRuntimeConfiguration(
          validEnvironment({
            PROGRAM_TEMPLATE_ORIGINS: 'https://valid.test',
          }),
        ),
      ).not.toThrow();
      expect(() =>
        validateRuntimeConfiguration(
          validEnvironment({
            PROGRAM_TEMPLATE_ORIGINS: 'http://insecure.test',
          }),
        ),
      ).toThrow('PROGRAM_TEMPLATE_ORIGINS contains an invalid origin');
    });
  });
});
