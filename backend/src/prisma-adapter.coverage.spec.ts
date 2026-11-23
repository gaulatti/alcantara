const mockPrismaPg = jest.fn();
jest.mock('@prisma/adapter-pg', () => ({
  PrismaPg: class {
    constructor(...args: unknown[]) {
      mockPrismaPg(...args);
    }
  },
}));

import { createPostgresAdapter } from './prisma-adapter';

describe('createPostgresAdapter', () => {
  beforeEach(() => mockPrismaPg.mockClear());

  it('throws when the database url is missing', () => {
    expect(() => createPostgresAdapter(undefined)).toThrow(
      'DATABASE_URL must be set to a valid Postgres connection string.',
    );
    expect(() => createPostgresAdapter('')).toThrow(/DATABASE_URL must be set/);
  });

  it('defaults to the public schema', () => {
    createPostgresAdapter('postgres://u:p@h:5432/db');
    expect(mockPrismaPg).toHaveBeenCalledWith(
      { connectionString: 'postgres://u:p@h:5432/db' },
      { schema: 'public' },
    );
  });

  it('extracts the schema query parameter and strips it from the connection string', () => {
    createPostgresAdapter(
      'postgres://u:p@h:5432/db?schema=custom&sslmode=require',
    );
    expect(mockPrismaPg).toHaveBeenCalledWith(
      { connectionString: 'postgres://u:p@h:5432/db?sslmode=require' },
      { schema: 'custom' },
    );
  });
});
