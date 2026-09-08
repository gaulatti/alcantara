import {
  loadRuntimeSecrets,
  validateAlanaRuntimeConfiguration,
  validatePalazzoRuntimeConfiguration,
} from './runtime-secrets';
import { readFile } from 'node:fs/promises';

jest.mock('node:fs/promises', () => ({ readFile: jest.fn() }));
const readFileMock = jest.mocked(readFile);

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
        palazzoControlToken: 'fictional-production-token',
        palazzoAllowedUrls: 'http://palazzo:3100',
        alanaControlToken: ALANA_TOKEN,
        alanaControlUrl: 'http://alana:8080',
        untrustedProperty: 'must-not-enter-environment',
      }),
    });
    await loadRuntimeSecrets(environment, { send });
    expect(environment).toMatchObject({
      PALAZZO_CONTROL_TOKEN: 'fictional-production-token',
      PALAZZO_ALLOWED_URLS: 'http://palazzo:3100',
      ALANA_CONTROL_TOKEN: ALANA_TOKEN,
      ALANA_CONTROL_URL: 'http://alana:8080',
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
    ).rejects.toThrow('private service configuration is incomplete');
    await expect(
      loadRuntimeSecrets({ NODE_ENV: 'production', AWS_REGION: 'us-east-1' }),
    ).rejects.toThrow(
      'ALCANTARA_CONFIG_SECRET_ID or both private control token files are required',
    );
  });

  it('supports explicit token files for both private services during production migration', async () => {
    readFileMock
      .mockResolvedValueOnce('existing-palazzo-control-token\n')
      .mockResolvedValueOnce(`${ALANA_TOKEN}\n`);
    const environment = {
      NODE_ENV: 'production',
      PALAZZO_CONTROL_TOKEN_FILE: '/run/secrets/palazzo-control-token',
      PALAZZO_ALLOWED_URLS: 'http://palazzo:3100',
      ALANA_CONTROL_TOKEN_FILE: '/run/secrets/alana-control-token',
      ALANA_CONTROL_URL: 'http://alana:8080',
    };

    await loadRuntimeSecrets(environment);

    expect(readFileMock).toHaveBeenCalledWith(
      '/run/secrets/palazzo-control-token',
      'utf8',
    );
    expect(readFileMock).toHaveBeenCalledWith(
      '/run/secrets/alana-control-token',
      'utf8',
    );
    expect(environment).toMatchObject({
      PALAZZO_CONTROL_TOKEN: 'existing-palazzo-control-token',
      ALANA_CONTROL_TOKEN: ALANA_TOKEN,
    });
  });

  it('does not contact AWS for explicit non-production configuration', async () => {
    const send = jest.fn();
    await loadRuntimeSecrets(
      {
        NODE_ENV: 'development',
        PALAZZO_CONTROL_TOKEN: 'palazzo-local-control-token',
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

  it('rejects malformed runtime tokens and approved URL lists', () => {
    expect(() =>
      validatePalazzoRuntimeConfiguration({
        PALAZZO_CONTROL_TOKEN: 'short',
        PALAZZO_ALLOWED_URLS: 'http://palazzo:3100',
      }),
    ).toThrow('PALAZZO_CONTROL_TOKEN is missing or invalid');
    expect(() =>
      validatePalazzoRuntimeConfiguration({
        PALAZZO_CONTROL_TOKEN: 'fictional-control-token',
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
