import { PrismaPg } from '@prisma/adapter-pg';

export function createPostgresAdapter(databaseUrl: string | undefined) {
  if (!databaseUrl) {
    throw new Error(
      'DATABASE_URL must be set to a valid Postgres connection string.',
    );
  }

  const parsedUrl = new URL(databaseUrl);
  const schema = parsedUrl.searchParams.get('schema') ?? 'public';
  parsedUrl.searchParams.delete('schema');

  return new PrismaPg(
    {
      connectionString: parsedUrl.toString(),
    },
    {
      schema,
    },
  );
}
