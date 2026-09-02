import { loadDatabaseSecret } from './database-secrets';

describe('loadDatabaseSecret', () => {
  it('hydrates DATABASE_URL from the allowlisted RDS payload', async () => {
    const environment = {
      ARAUCO_SECRET_ID: 'arauco-secret',
      AWS_REGION: 'us-east-1',
      DATABASE_URL: 'postgresql://stale.invalid/ignored',
    };
    const send = jest.fn().mockResolvedValue({
      SecretString: JSON.stringify({
        username: 'alcantara',
        password: 'fictional p@ssword',
        host: 'arauco.private.example',
        port: 5432,
        dbname: 'alcantara',
        untrusted: 'ignored',
      }),
    });

    await loadDatabaseSecret(environment, { send });

    expect(environment.DATABASE_URL).toBe(
      'postgresql://alcantara:fictional%20p%40ssword@arauco.private.example:5432/alcantara?schema=public&sslmode=require',
    );
  });

  it('keeps explicit database configuration when no secret is selected', async () => {
    const environment = { DATABASE_URL: 'postgresql://local.test/alcantara' };
    const send = jest.fn();
    await loadDatabaseSecret(environment, { send });
    expect(send).not.toHaveBeenCalled();
  });

  it('fails closed for missing, unavailable, or malformed configuration', async () => {
    await expect(loadDatabaseSecret({})).rejects.toThrow(
      'ARAUCO_SECRET_ID or DATABASE_URL is required',
    );
    await expect(
      loadDatabaseSecret(
        { ARAUCO_SECRET_ID: 'arauco-secret', AWS_REGION: 'us-east-1' },
        { send: jest.fn().mockRejectedValue(new Error('provider detail')) },
      ),
    ).rejects.toThrow('database configuration is unavailable');
    await expect(
      loadDatabaseSecret(
        { ARAUCO_SECRET_ID: 'arauco-secret', AWS_REGION: 'us-east-1' },
        { send: jest.fn().mockResolvedValue({ SecretString: '{}' }) },
      ),
    ).rejects.toThrow('database configuration is malformed');
  });
});
