import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const mockPrismaClient = jest.fn();
const mockLoadDatabaseSecret = jest.fn();
const mockCreateAdapter = jest.fn();

jest.mock('@prisma/client', () => ({
  ...jest.requireActual('@prisma/client'),
  PrismaClient: function PrismaClientMock(this: unknown, options: unknown) {
    return mockPrismaClient(options);
  },
}));
jest.mock('../config/database-secrets', () => ({
  loadDatabaseSecret: (...args: unknown[]) => mockLoadDatabaseSecret(...args),
}));
jest.mock('../prisma-adapter', () => ({
  createPostgresAdapter: (...args: unknown[]) => mockCreateAdapter(...args),
}));

import { runPrincipalMigrationCli } from './principals-cli';

describe('principal migration CLI default dependencies', () => {
  const originalUrl = process.env.DATABASE_URL;

  beforeEach(() => {
    jest.clearAllMocks();
    mockLoadDatabaseSecret.mockResolvedValue(undefined);
    mockCreateAdapter.mockReturnValue({ adapter: true });
  });
  afterEach(() => {
    jest.restoreAllMocks();
    if (originalUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalUrl;
  });

  function clientWithRows() {
    const transaction = {
      operatorPreference: {
        findMany: jest
          .fn()
          .mockResolvedValue([
            { deviceClass: 'desktop', principalId: null, subject: 'sp' },
          ]),
      },
      sharedConsoleLayout: { findMany: jest.fn().mockResolvedValue([]) },
      guestInvitation: { findMany: jest.fn().mockResolvedValue([]) },
      guestEvent: { findMany: jest.fn().mockResolvedValue([]) },
    };
    return {
      $transaction: jest.fn(async (cb: (tx: never) => Promise<unknown>) =>
        cb(transaction as never),
      ),
      $disconnect: jest.fn().mockResolvedValue(undefined),
    };
  }

  it('reports usage errors on console.error', async () => {
    const error = jest.spyOn(console, 'error').mockImplementation();
    await expect(runPrincipalMigrationCli(['bogus'])).resolves.toBe(2);
    expect(error).toHaveBeenCalledWith(
      'Usage: principals-cli <export|report|apply> <path> [--allow-conflicts]',
    );
  });

  it('bootstraps the database secret, builds the adapter client, writes a private file, and logs', async () => {
    process.env.DATABASE_URL = 'postgresql://u:p@h/db';
    const client = clientWithRows();
    mockPrismaClient.mockReturnValue(client);
    const log = jest.spyOn(console, 'log').mockImplementation();
    const target = join(
      mkdtempSync(join(tmpdir(), 'principals-defaults-')),
      'refs.json',
    );

    await expect(runPrincipalMigrationCli(['export', target])).resolves.toBe(0);

    expect(mockLoadDatabaseSecret).toHaveBeenCalledTimes(1);
    expect(mockCreateAdapter).toHaveBeenCalledWith('postgresql://u:p@h/db');
    expect(mockPrismaClient).toHaveBeenCalledWith({
      adapter: { adapter: true },
    });
    expect(existsSync(target)).toBe(true);
    expect(statSync(target).mode & 0o777).toBe(0o600);
    const written = JSON.parse(readFileSync(target, 'utf8')) as Array<{
      subject: string;
    }>;
    expect(written).toHaveLength(1);
    expect(written[0].subject).toBe('sp');
    expect(readFileSync(target, 'utf8').endsWith('\n')).toBe(true);
    expect(log).toHaveBeenCalledWith(
      'Wrote 1 Alcantara references for Pompeii.',
    );
    expect(client.$disconnect).toHaveBeenCalledTimes(1);
  });

  it('refuses to overwrite an existing references file', async () => {
    mockPrismaClient.mockReturnValue(clientWithRows());
    const target = join(
      mkdtempSync(join(tmpdir(), 'principals-defaults-')),
      'refs.json',
    );
    jest.spyOn(console, 'log').mockImplementation();
    await runPrincipalMigrationCli(['export', target]);
    mockPrismaClient.mockReturnValue(clientWithRows());
    await expect(
      runPrincipalMigrationCli(['export', target]),
    ).rejects.toMatchObject({ code: 'EEXIST' });
  });
});
