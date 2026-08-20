export const TEST_AUTH_ISSUER = 'pompeii-local-test-auth';
export const TEST_AUTH_AUDIENCE = 'local-browser-tests';

export function testAuthEnabled(): boolean {
  return process.env.AUTH_MODE === 'test';
}

export function testAuthSecret(): string {
  const secret = process.env.TEST_AUTH_SECRET ?? '';
  if (secret.length < 32) throw new Error('TEST_AUTH_SECRET must contain at least 32 characters');
  return secret;
}

export function assertTestAuthConfiguration(): void {
  if (!testAuthEnabled()) return;
  if (process.env.NODE_ENV === 'production') {
    throw new Error('AUTH_MODE=test must never run with NODE_ENV=production');
  }
  testAuthSecret();
}
