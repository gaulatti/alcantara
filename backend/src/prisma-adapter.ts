import { PrismaPg } from '@prisma/adapter-pg';
import { READ_ONLY_SESSION_OPTION } from './config/deploy-candidate';

/**
 * `readOnly` (a deploy candidate, gaulatti/alcantara#223) opens every session
 * with `default_transaction_read_only`, after any options the address
 * already carries, so PostgreSQL itself refuses every write.
 */
export function createPostgresAdapter(
  databaseUrl: string | undefined,
  { readOnly = false }: { readOnly?: boolean } = {},
) {
  if (!databaseUrl) {
    throw new Error(
      'DATABASE_URL must be set to a valid Postgres connection string.',
    );
  }

  const parsedUrl = new URL(databaseUrl);
  const schema = parsedUrl.searchParams.get('schema') ?? 'public';
  parsedUrl.searchParams.delete('schema');
  if (readOnly) {
    const options = parsedUrl.searchParams.get('options');
    parsedUrl.searchParams.set(
      'options',
      options
        ? `${options} ${READ_ONLY_SESSION_OPTION}`
        : READ_ONLY_SESSION_OPTION,
    );
  }

  return new PrismaPg(
    {
      connectionString: parsedUrl.toString(),
    },
    {
      schema,
    },
  );
}
