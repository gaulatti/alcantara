import { ConfigService } from '@nestjs/config';
import { sign } from 'jsonwebtoken';
import { ALCANTARA_PERMISSIONS } from './permissions';
import {
  assertTestAuthSafety,
  TEST_AUTH_AUDIENCE,
  TEST_AUTH_ISSUER,
  TestAuthService,
} from './test-auth.service';

function service(values: Record<string, string> = {}) {
  return new TestAuthService(
    new ConfigService({
      NODE_ENV: 'test',
      AUTH_MODE: 'test',
      TEST_AUTH_SECRET: 'fictional-local-test-secret-over-32-chars',
      ...values,
    }),
  );
}

describe('TestAuthService', () => {
  it('refuses test auth in production and weak local signing keys', () => {
    expect(() =>
      assertTestAuthSafety({ AUTH_MODE: 'test', NODE_ENV: 'production' }),
    ).toThrow('must never run');
    expect(() => service({ TEST_AUTH_SECRET: 'short' })).toThrow(
      'at least 32 characters',
    );
  });

  it('issues isolated operator and viewer permissions through normal authorization', () => {
    const auth = service();
    const operator = auth.issue('operator-a');
    const viewer = auth.issue('viewer');
    expect(
      auth.authorize(
        `Bearer ${operator.accessToken}`,
        ALCANTARA_PERMISSIONS.layout.manage,
        1,
      ),
    ).toMatchObject({
      authenticated: true,
      allowed: true,
      subject: 'test:alcantara:operator-a',
    });
    expect(
      auth.authorize(
        `Bearer ${viewer.accessToken}`,
        ALCANTARA_PERMISSIONS.layout.manage,
        1,
      ),
    ).toMatchObject({
      authenticated: true,
      allowed: false,
      subject: 'test:alcantara:viewer',
    });
  });

  it.each([
    { issuer: 'wrong', audience: TEST_AUTH_AUDIENCE, expiresIn: 60 },
    { issuer: TEST_AUTH_ISSUER, audience: 'wrong', expiresIn: 60 },
    { issuer: TEST_AUTH_ISSUER, audience: TEST_AUTH_AUDIENCE, expiresIn: -1 },
  ])('rejects an invalid issuer, audience, or expiry', (options) => {
    const auth = service();
    const token = sign(
      {
        sub: 'test:alcantara:operator-a',
        permissions: [ALCANTARA_PERMISSIONS.access],
      },
      'fictional-local-test-secret-over-32-chars',
      { algorithm: 'HS256', ...options },
    );
    expect(
      auth.authorize(`Bearer ${token}`, ALCANTARA_PERMISSIONS.access, 1),
    ).toMatchObject({ authenticated: false, allowed: false });
  });

  it('hides session issuance when disabled', () => {
    const auth = service({ AUTH_MODE: 'cognito', TEST_AUTH_SECRET: '' });
    expect(() => auth.issue()).toThrow();
  });
});
