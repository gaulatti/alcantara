import { ConfigService } from '@nestjs/config';
import { NotFoundException, UnauthorizedException } from '@nestjs/common';
import { sign, verify } from 'jsonwebtoken';
import { ALCANTARA_PERMISSIONS } from './permissions';
import {
  TEST_AUTH_AUDIENCE,
  TEST_AUTH_ISSUER,
  TestAuthService,
  assertTestAuthSafety,
} from './test-auth.service';

const SECRET = 'fictional-local-test-secret-over-32-chars';

function service(values: Record<string, string | undefined> = {}) {
  return new TestAuthService(
    new ConfigService({
      NODE_ENV: 'test',
      AUTH_MODE: 'test',
      TEST_AUTH_SECRET: SECRET,
      ...values,
    }),
  );
}

function token(payload: Record<string, unknown>, secret = SECRET) {
  return sign(payload, secret, {
    algorithm: 'HS256',
    issuer: TEST_AUTH_ISSUER,
    audience: TEST_AUTH_AUDIENCE,
    expiresIn: 60,
  });
}

describe('assertTestAuthSafety', () => {
  const original = process.env;
  afterEach(() => {
    process.env = original;
  });

  it('defaults to process.env', () => {
    process.env = { ...original, AUTH_MODE: 'test', NODE_ENV: 'production' };
    expect(() => assertTestAuthSafety()).toThrow(
      'AUTH_MODE=test must never run with NODE_ENV=production',
    );
    process.env = { ...original, AUTH_MODE: 'test', NODE_ENV: 'development' };
    expect(() => assertTestAuthSafety()).not.toThrow();
  });

  it('allows production when test auth is not selected', () => {
    expect(() =>
      assertTestAuthSafety({ AUTH_MODE: 'cognito', NODE_ENV: 'production' }),
    ).not.toThrow();
  });
});

describe('TestAuthService constructor', () => {
  it('stays disabled without a secret when test auth is not selected', () => {
    const auth = service({ AUTH_MODE: undefined, TEST_AUTH_SECRET: undefined });
    expect(auth.isEnabled()).toBe(false);
  });

  it('is enabled with a long enough secret', () => {
    expect(service().isEnabled()).toBe(true);
  });

  it('refuses enabled mode with no secret configured', () => {
    expect(() => service({ TEST_AUTH_SECRET: undefined })).toThrow(
      'TEST_AUTH_SECRET must contain at least 32 characters',
    );
  });

  it('refuses test auth under production', () => {
    expect(() => service({ NODE_ENV: 'production' })).toThrow('must never run');
  });
});

describe('TestAuthService.issue', () => {
  it('issues operator tokens with every permission', () => {
    const session = service().issue('operator-b');
    expect(session.user).toEqual({
      sub: 'test:alcantara:operator-b',
      id: 'test:alcantara:operator-b',
      name: 'operator-b',
      email: 'operator-b@alcantara.local',
    });
    const claims = verify(session.accessToken, SECRET) as Record<
      string,
      unknown
    >;
    expect(claims.roles).toEqual(['operator']);
    expect(claims.permissions).toEqual(
      expect.arrayContaining([
        ALCANTARA_PERMISSIONS.access,
        ALCANTARA_PERMISSIONS.broadcast.manage,
        ALCANTARA_PERMISSIONS.upload.create,
      ]),
    );
    expect(claims.iss).toBe(TEST_AUTH_ISSUER);
    expect(claims.aud).toBe(TEST_AUTH_AUDIENCE);
    expect(Date.parse(session.expiresAt)).toBeGreaterThan(Date.now());
  });

  it('issues viewer tokens with read-only permissions', () => {
    const claims = verify(
      service().issue('viewer').accessToken,
      SECRET,
    ) as Record<string, unknown>;
    expect(claims.roles).toEqual(['viewer']);
    expect(claims.permissions).toEqual([
      ALCANTARA_PERMISSIONS.access,
      ALCANTARA_PERMISSIONS.program.read,
      ALCANTARA_PERMISSIONS.layout.read,
      ALCANTARA_PERMISSIONS.broadcast.view,
    ]);
  });

  it.each([undefined, 'someone-else'])(
    'falls back to operator-a for identity %p',
    (identity) => {
      expect(service().issue(identity).user.sub).toBe(
        'test:alcantara:operator-a',
      );
    },
  );

  it('hides issuance with 404 when disabled', () => {
    expect(() =>
      service({ AUTH_MODE: 'cognito', TEST_AUTH_SECRET: '' }).issue(),
    ).toThrow(NotFoundException);
  });
});

describe('TestAuthService.authorize', () => {
  it('rejects every call when disabled', () => {
    const auth = service({ AUTH_MODE: 'cognito', TEST_AUTH_SECRET: '' });
    expect(() =>
      auth.authorize('Bearer x', ALCANTARA_PERMISSIONS.access, 1),
    ).toThrow(UnauthorizedException);
  });

  it('strips a case-insensitive Bearer prefix and allows a granted permission', () => {
    const auth = service();
    const t = token({
      sub: 'subject-1',
      permissions: [ALCANTARA_PERMISSIONS.access, 5],
      roles: ['custom', 7],
    });
    expect(
      auth.authorize(`bearer   ${t}`, ALCANTARA_PERMISSIONS.access, 4),
    ).toEqual({
      authenticated: true,
      allowed: true,
      reason: 'ALLOW_TEST_AUTH',
      subject: 'subject-1',
      principalId: null,
      effectivePermissions: [ALCANTARA_PERMISSIONS.access],
      roles: ['custom', 'team:4'],
    });
    expect(auth.authorize(t, ALCANTARA_PERMISSIONS.access, 4).allowed).toBe(
      true,
    );
  });

  it('denies an ungranted permission', () => {
    const decision = service().authorize(
      token({
        sub: 's',
        permissions: [ALCANTARA_PERMISSIONS.access],
        roles: [],
      }),
      ALCANTARA_PERMISSIONS.layout.manage,
      1,
    );
    expect(decision).toMatchObject({
      authenticated: true,
      allowed: false,
      reason: 'DENY_PERMISSION',
    });
  });

  it('tolerates tokens without permission/role arrays or a string subject', () => {
    const decision = service().authorize(
      token({ sub: 12, permissions: 'all', roles: 'admin' }),
      ALCANTARA_PERMISSIONS.access,
      3,
    );
    expect(decision).toEqual({
      authenticated: false,
      allowed: false,
      reason: 'DENY_PERMISSION',
      subject: '',
      principalId: null,
      effectivePermissions: [],
      roles: ['team:3'],
    });
  });

  it('returns an invalid-token denial for bad signatures and garbage', () => {
    const auth = service();
    const expected = {
      authenticated: false,
      allowed: false,
      reason: 'DENY_INVALID_TEST_TOKEN',
      subject: '',
      principalId: null,
      effectivePermissions: [],
      roles: [],
    };
    expect(
      auth.authorize(
        token({ sub: 's' }, 'another-secret-that-is-long-enough-xx'),
        ALCANTARA_PERMISSIONS.access,
        1,
      ),
    ).toEqual(expected);
    expect(auth.authorize('garbage', ALCANTARA_PERMISSIONS.access, 1)).toEqual(
      expected,
    );
  });
});

describe('TestAuthService design metadata under unresolved circular imports', () => {
  it('records Object for the config dependency when its module is not yet defined', () => {
    jest.isolateModules(() => {
      jest.doMock('@nestjs/config', () => ({}));
      const { TestAuthService: Isolated } = require('./test-auth.service');
      expect(Reflect.getMetadata('design:paramtypes', Isolated)).toEqual([
        Object,
      ]);
    });
  });
});
