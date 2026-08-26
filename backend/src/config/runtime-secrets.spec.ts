import {
  loadRuntimeSecrets,
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

describe('loadRuntimeSecrets', () => {
  it('selects only allowlisted Palazzo scalars from the production payload', async () => {
    const environment = productionEnvironment();
    const send = jest.fn().mockResolvedValue({
      SecretString: JSON.stringify({
        palazzoControlToken: 'fictional-production-token',
        palazzoAllowedUrls: 'http://palazzo:3100',
        untrustedProperty: 'must-not-enter-environment',
      }),
    });
    await loadRuntimeSecrets(environment, { send });
    expect(environment).toMatchObject({
      PALAZZO_CONTROL_TOKEN: 'fictional-production-token',
      PALAZZO_ALLOWED_URLS: 'http://palazzo:3100',
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
    ).rejects.toThrow('Palazzo configuration is incomplete');
    await expect(
      loadRuntimeSecrets({ NODE_ENV: 'production', AWS_REGION: 'us-east-1' }),
    ).rejects.toThrow(
      'ALCANTARA_CONFIG_SECRET_ID or PALAZZO_CONTROL_TOKEN_FILE is required',
    );
  });

  it('supports the existing Palazzo token file during production migration', async () => {
    readFileMock.mockResolvedValue('existing-palazzo-control-token\n');
    const environment = {
      NODE_ENV: 'production',
      PALAZZO_CONTROL_TOKEN_FILE: '/run/secrets/palazzo-control-token',
      PALAZZO_ALLOWED_URLS: 'http://palazzo:3100',
    };

    await loadRuntimeSecrets(environment);

    expect(readFileMock).toHaveBeenCalledWith(
      '/run/secrets/palazzo-control-token',
      'utf8',
    );
    expect(environment).toMatchObject({
      PALAZZO_CONTROL_TOKEN: 'existing-palazzo-control-token',
    });
  });

  it('does not contact AWS for explicit non-production configuration', async () => {
    const send = jest.fn();
    await loadRuntimeSecrets(
      {
        NODE_ENV: 'development',
        PALAZZO_CONTROL_TOKEN: 'palazzo-local-control-token',
        PALAZZO_ALLOWED_URLS: 'http://palazzo:3100',
      },
      { send },
    );
    expect(send).not.toHaveBeenCalled();
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
  });
});
