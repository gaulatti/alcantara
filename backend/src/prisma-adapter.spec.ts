import { PrismaPg } from '@prisma/adapter-pg';
import { createPostgresAdapter } from './prisma-adapter';

jest.mock('@prisma/adapter-pg', () => ({
  PrismaPg: jest
    .fn()
    .mockImplementation((config: unknown, options: unknown) => ({
      config,
      options,
    })),
}));

describe('createPostgresAdapter', () => {
  beforeEach(() => {
    (PrismaPg as unknown as jest.Mock).mockClear();
  });

  it('fails fast when the database url is missing', () => {
    expect(() => createPostgresAdapter(undefined)).toThrow(
      'DATABASE_URL must be set to a valid Postgres connection string.',
    );
    expect(() => createPostgresAdapter('')).toThrow('DATABASE_URL must be set');
    expect(PrismaPg).not.toHaveBeenCalled();
  });

  it('moves the schema search parameter into adapter options', () => {
    createPostgresAdapter(
      'postgresql://u:p@db.invalid:5432/app?schema=tenant&sslmode=require',
    );
    expect(PrismaPg).toHaveBeenCalledWith(
      {
        connectionString:
          'postgresql://u:p@db.invalid:5432/app?sslmode=require',
      },
      { schema: 'tenant' },
    );
  });

  it('uses the public schema when none is specified', () => {
    createPostgresAdapter('postgresql://u:p@db.invalid:5432/app');
    expect(PrismaPg).toHaveBeenCalledWith(
      { connectionString: 'postgresql://u:p@db.invalid:5432/app' },
      { schema: 'public' },
    );
  });
});
