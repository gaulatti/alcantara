import {
  ForbiddenException,
  UnauthorizedException,
  type ExecutionContext,
} from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { PompeiiAuthorizationGuard } from './pompeii-authorization.guard';
import { ALCANTARA_PERMISSIONS } from './permissions';
import type { PompeiiService } from './pompeii.service';
import type { TestAuthService } from './test-auth.service';

const permission = ALCANTARA_PERMISSIONS.program.read;

function contextFor(request: Record<string, unknown>): ExecutionContext {
  return {
    getHandler: () => function handler() {},
    getClass: () => class Controller {},
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

function reflectorFor(isPublic: boolean, required?: string): Reflector {
  return {
    getAllAndOverride: jest
      .fn()
      .mockReturnValueOnce(isPublic)
      .mockReturnValueOnce(required),
  } as unknown as Reflector;
}

const decision = {
  authenticated: true,
  allowed: true,
  reason: 'ALLOW',
  subject: 'subject-a',
  principalId: 'principal-a',
  effectivePermissions: [permission],
  roles: ['operator'],
};

describe('PompeiiAuthorizationGuard test-auth and request shaping', () => {
  it('authorizes through local test auth when enabled, never calling Pompeii', async () => {
    const pompeii = { teamId: 9, authorize: jest.fn() };
    const testAuth = {
      isEnabled: jest.fn().mockReturnValue(true),
      authorize: jest.fn().mockReturnValue(decision),
    };
    const guard = new PompeiiAuthorizationGuard(
      reflectorFor(false, permission),
      pompeii as unknown as PompeiiService,
      testAuth as unknown as TestAuthService,
    );
    const request: Record<string, unknown> = {
      headers: { authorization: 'Bearer local' },
    };

    await expect(guard.canActivate(contextFor(request))).resolves.toBe(true);

    expect(testAuth.authorize).toHaveBeenCalledWith(
      'Bearer local',
      permission,
      9,
    );
    expect(pompeii.authorize).not.toHaveBeenCalled();
    expect(request.user).toEqual({
      sub: 'subject-a',
      principalId: 'principal-a',
      authorization: {
        permission,
        permissions: [permission],
        roles: ['operator'],
        teamId: 9,
      },
    });
  });

  it('uses Pompeii when test auth is present but disabled and preserves existing user fields', async () => {
    const pompeii = {
      teamId: 2,
      authorize: jest.fn().mockResolvedValue(decision),
    };
    const testAuth = {
      isEnabled: jest.fn().mockReturnValue(false),
      authorize: jest.fn(),
    };
    const guard = new PompeiiAuthorizationGuard(
      reflectorFor(false, permission),
      pompeii as unknown as PompeiiService,
      testAuth as unknown as TestAuthService,
    );
    const request: Record<string, unknown> = {
      headers: { authorization: 'Bearer remote' },
      user: { existing: true },
    };

    await guard.canActivate(contextFor(request));

    expect(pompeii.authorize).toHaveBeenCalledWith('Bearer remote', permission);
    expect(testAuth.authorize).not.toHaveBeenCalled();
    expect(request.user).toMatchObject({ existing: true, sub: 'subject-a' });
  });

  it('surfaces unauthenticated, forbidden, and missing-subject decisions from test auth', async () => {
    const run = (value: Partial<typeof decision>) =>
      new PompeiiAuthorizationGuard(
        reflectorFor(false, permission),
        { teamId: 1 } as unknown as PompeiiService,
        {
          isEnabled: () => true,
          authorize: () => ({ ...decision, ...value }),
        } as unknown as TestAuthService,
      ).canActivate(contextFor({ headers: { authorization: 'Bearer x' } }));

    await expect(run({ authenticated: false, reason: 'BAD' })).rejects.toThrow(
      UnauthorizedException,
    );
    await expect(run({ allowed: false, reason: 'NOPE' })).rejects.toThrow(
      ForbiddenException,
    );
    await expect(run({ subject: '   ' })).rejects.toMatchObject({
      response: { error: 'UNAUTHENTICATED', reason: 'DENY_MISSING_SUBJECT' },
    });
  });

  it('records Object for dependencies whose modules are not yet defined', () => {
    jest.isolateModules(() => {
      jest.doMock('./pompeii.service', () => ({}));
      jest.doMock('./test-auth.service', () => ({}));
      jest.doMock('@nestjs/core', () => ({}));
      const {
        PompeiiAuthorizationGuard: Isolated,
      } = require('./pompeii-authorization.guard');
      expect(Reflect.getMetadata('design:paramtypes', Isolated)).toEqual([
        Object,
        Object,
        Object,
      ]);
    });
  });
});
