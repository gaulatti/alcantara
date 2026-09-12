import {
  loadRuntimeSecrets,
  validateExternalSourceEncryption,
  validateAlanaRuntimeConfiguration,
  validatePalazzoRuntimeConfiguration,
} from './runtime-secrets';
import { readFile } from 'node:fs/promises';

jest.mock('node:fs/promises', () => ({ readFile: jest.fn() }));
const readFileMock = jest.mocked(readFile);
const sourceKeys = '{"1":"YWxjYW50YXJhLWxvY2FsLXNvdXJjZS1rZXktMDAwMDA="}';

function productionEnvironment() {
  return {
    NODE_ENV: 'production',
    AWS_REGION: 'us-east-1',
    ALCANTARA_CONFIG_SECRET_ID: 'alcantara/production/config',
  };
}

const ALANA_TOKEN =
  'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

describe('loadRuntimeSecrets', () => {
  it('selects only allowlisted private-service scalars from the production payload', async () => {
    const environment = productionEnvironment();
    const send = jest.fn().mockResolvedValue({
      SecretString: JSON.stringify({
        palazzoAllowedUrls: 'http://palazzo:3100',
        alanaControlToken: ALANA_TOKEN,
        alanaControlUrl: 'http://alana:8080',
        externalSourceConfigCurrentVersion: '1',
        externalSourceConfigKeys: sourceKeys,
        untrustedProperty: 'must-not-enter-environment',
      }),
    });
    await loadRuntimeSecrets(environment, { send });
    expect(environment).toMatchObject({
      PALAZZO_ALLOWED_URLS: 'http://palazzo:3100',
      ALANA_CONTROL_TOKEN: ALANA_TOKEN,
      ALANA_CONTROL_URL: 'http://alana:8080',
      EXTERNAL_SOURCE_CONFIG_CURRENT_VERSION: '1',
      EXTERNAL_SOURCE_CONFIG_KEYS: sourceKeys,
    });
    expect(environment).not.toHaveProperty('untrustedProperty');
  });

  it('fails production startup before client construction when secret config is unavailable or malformed', async () => {
    await expect(
      loadRuntimeSecrets(productionEnvironment(), {
        send: jest.fn().mockRejectedValue(new Error('provider detail')),
      }),
    ).rejects.toThrow('runtime configuration is unavailable');
    await expect(
      loadRuntimeSecrets(productionEnvironment(), {
        send: jest.fn().mockResolvedValue({ SecretString: '{}' }),
      }),
    ).rejects.toThrow('runtime configuration is incomplete');
    await expect(
      loadRuntimeSecrets({ NODE_ENV: 'production', AWS_REGION: 'us-east-1' }),
    ).rejects.toThrow(
      'ALCANTARA_CONFIG_SECRET_ID or ALANA_CONTROL_TOKEN_FILE is required',
    );
  });

  it('supports an explicit Alana token file during production migration', async () => {
    readFileMock.mockResolvedValueOnce(`${ALANA_TOKEN}\n`);
    const environment = {
      NODE_ENV: 'production',
      PALAZZO_ALLOWED_URLS: 'http://palazzo:3100',
      ALANA_CONTROL_TOKEN_FILE: '/run/secrets/alana-control-token',
      ALANA_CONTROL_URL: 'http://alana:8080',
      EXTERNAL_SOURCE_CONFIG_CURRENT_VERSION: '1',
      EXTERNAL_SOURCE_CONFIG_KEYS: sourceKeys,
    };

    await loadRuntimeSecrets(environment);

    expect(readFileMock).toHaveBeenCalledWith(
      '/run/secrets/alana-control-token',
      'utf8',
    );
    expect(environment).toMatchObject({
      ALANA_CONTROL_TOKEN: ALANA_TOKEN,
    });
  });

  it('fails closed for an absent or malformed external-source keyring', () => {
    expect(() => validateExternalSourceEncryption({})).toThrow('malformed');
    expect(() =>
      validateExternalSourceEncryption({
        EXTERNAL_SOURCE_CONFIG_CURRENT_VERSION: '2',
        EXTERNAL_SOURCE_CONFIG_KEYS: sourceKeys,
      }),
    ).toThrow('malformed');
  });

  it('does not contact AWS for explicit non-production configuration', async () => {
    const send = jest.fn();
    await loadRuntimeSecrets(
      {
        NODE_ENV: 'development',
        PALAZZO_ALLOWED_URLS: 'http://palazzo:3100',
        ALANA_CONTROL_URL: 'http://alana:8080',
        ALANA_CONTROL_TOKEN: 'alana-local-control-token',
      },
      { send },
    );
    expect(send).not.toHaveBeenCalled();
  });

  it('rejects malformed Alana machine-control configuration', () => {
    expect(() =>
      validateAlanaRuntimeConfiguration({
        ALANA_CONTROL_URL: 'http://user:password@alana:8080',
        ALANA_CONTROL_TOKEN: ALANA_TOKEN,
      }),
    ).toThrow('ALANA_CONTROL_URL contains an invalid URL');
    expect(() =>
      validateAlanaRuntimeConfiguration({
        ALANA_CONTROL_URL: 'http://alana:8080',
        ALANA_CONTROL_TOKEN: 'short',
      }),
    ).toThrow('ALANA_CONTROL_TOKEN is missing or invalid');
  });

  it('rejects malformed private-service URLs', () => {
    expect(() =>
      validatePalazzoRuntimeConfiguration({
        PALAZZO_ALLOWED_URLS: 'http://user:password@palazzo:3100',
      }),
    ).toThrow('PALAZZO_ALLOWED_URLS contains an invalid URL');
    expect(() =>
      validateAlanaRuntimeConfiguration({
        ALANA_CONTROL_TOKEN: ALANA_TOKEN,
        ALANA_CONTROL_URL: 'http://alana:8080/private/path',
      }),
    ).toThrow('ALANA_CONTROL_URL contains an invalid URL');
  });
});
