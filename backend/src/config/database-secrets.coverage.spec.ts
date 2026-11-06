import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import { loadDatabaseSecret } from './database-secrets';

jest.mock('@aws-sdk/client-secrets-manager', () => ({
  GetSecretValueCommand: jest.fn().mockImplementation((input: unknown) => ({
    input,
  })),
  SecretsManagerClient: jest.fn(),
}));

const good = {
  username: 'u',
  password: 'p',
  host: 'h.example',
  port: 5432,
  dbname: 'db',
};

async function load(secret: unknown) {
  const environment: Record<string, string> = {
    ARAUCO_SECRET_ID: 'id',
    AWS_REGION: 'us-east-1',
  };
  await loadDatabaseSecret(environment, {
    send: jest.fn().mockResolvedValue({
      SecretString:
        typeof secret === 'string' ? secret : JSON.stringify(secret),
    }),
  });
  return environment;
}

describe('loadDatabaseSecret coverage', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
  });
  afterAll(() => {
    process.env = originalEnv;
  });

  it('defaults to process.env and keeps a configured DATABASE_URL', async () => {
    delete process.env.ARAUCO_SECRET_ID;
    process.env.DATABASE_URL = 'postgresql://local/db';
    await expect(loadDatabaseSecret()).resolves.toBeUndefined();
    process.env.DATABASE_URL = '   ';
    await expect(loadDatabaseSecret()).rejects.toThrow(
      'ARAUCO_SECRET_ID or DATABASE_URL is required',
    );
  });

  it('treats a blank secret id as unset', async () => {
    await expect(
      loadDatabaseSecret({ ARAUCO_SECRET_ID: '  ', DATABASE_URL: 'x://y' }),
    ).resolves.toBeUndefined();
  });

  it('requires a region and honors AWS_DEFAULT_REGION with the default client', async () => {
    await expect(
      loadDatabaseSecret({ ARAUCO_SECRET_ID: 'id' }, { send: jest.fn() }),
    ).rejects.toThrow('AWS_REGION is required');

    const send = jest
      .fn()
      .mockResolvedValue({ SecretString: JSON.stringify(good) });
    jest
      .mocked(SecretsManagerClient)
      .mockImplementation(() => ({ send }) as unknown as SecretsManagerClient);
    const environment: Record<string, string> = {
      ARAUCO_SECRET_ID: ' arauco ',
      AWS_DEFAULT_REGION: 'eu-west-1',
    };
    await loadDatabaseSecret(environment);
    expect(SecretsManagerClient).toHaveBeenCalledWith({ region: 'eu-west-1' });
    expect(GetSecretValueCommand).toHaveBeenCalledWith({ SecretId: 'arauco' });
    expect(environment.DATABASE_URL).toBe(
      'postgresql://u:p@h.example:5432/db?schema=public&sslmode=verify-full&sslrootcert=%2Fapp%2Fcerts%2Fglobal-bundle.pem',
    );
  });

  it('accepts a numeric-string port', async () => {
    const environment = await load({ ...good, port: '6543' });
    expect(environment.DATABASE_URL).toContain('@h.example:6543/db');
  });

  it.each([
    ['invalid json', 'nope'],
    ['empty secret', ''],
    ['null', 'null'],
    ['array', '[]'],
    ['string', '"x"'],
    ['missing username', { ...good, username: undefined }],
    ['empty username', { ...good, username: '' }],
    ['non-string username', { ...good, username: 1 }],
    ['missing password', { ...good, password: undefined }],
    ['empty password', { ...good, password: '' }],
    ['missing host', { ...good, host: undefined }],
    ['empty host', { ...good, host: '' }],
    ['fractional port', { ...good, port: 5432.5 }],
    ['zero port', { ...good, port: 0 }],
    ['oversized port', { ...good, port: 65536 }],
    ['non-numeric port', { ...good, port: 'abc' }],
    ['missing dbname', { ...good, dbname: undefined }],
    ['empty dbname', { ...good, dbname: '' }],
  ])('rejects a malformed payload: %s', async (_name, secret) => {
    await expect(load(secret)).rejects.toThrow(
      'Arauco database configuration is malformed',
    );
  });

  it('treats a missing SecretString as malformed', async () => {
    await expect(
      loadDatabaseSecret(
        { ARAUCO_SECRET_ID: 'id', AWS_REGION: 'us-east-1' },
        { send: jest.fn().mockResolvedValue({}) },
      ),
    ).rejects.toThrow('Arauco database configuration is malformed');
  });
});
