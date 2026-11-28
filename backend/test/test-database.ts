/**
 * The database the database-backed specs may truncate. It comes from TEST_DATABASE_URL, and defaults to CI's own
 * database, so CI is unchanged. The name is checked before any test runs: only a database named alcantara_ci, or one
 * whose name ends in _test, is accepted. DATABASE_URL is never read here, since inside a container it can point at a
 * real database.
 */
export const CI_TEST_DATABASE_URL =
  'postgresql://alcantara:alcantara-ci-password@127.0.0.1:5432/alcantara_ci?schema=public';

export function testDatabaseUrl(): string {
  const value = process.env.TEST_DATABASE_URL || CI_TEST_DATABASE_URL;
  const name = new URL(value).pathname.replace(/^\//, '');
  if (name !== 'alcantara_ci' && !name.endsWith('_test')) {
    throw new Error(
      `refusing to run database tests against "${name}": the test database must be named alcantara_ci or end in _test`,
    );
  }
  return value;
}
