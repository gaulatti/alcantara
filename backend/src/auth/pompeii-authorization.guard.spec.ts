import {
  ForbiddenException,
  InternalServerErrorException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { ExecutionContext } from '@nestjs/common';
import { PompeiiAuthorizationGuard } from './pompeii-authorization.guard';
import { ALCANTARA_PERMISSIONS } from './permissions';
import type { PompeiiService } from './pompeii.service';

const context = (authorization?: string): ExecutionContext =>
  ({
    getHandler: () => function handler() {},
    getClass: () => class Controller {},
    switchToHttp: () => ({
      getRequest: () => ({ headers: { authorization }, user: { sub: 'user' } }),
    }),
  }) as unknown as ExecutionContext;

describe('PompeiiAuthorizationGuard', () => {
  const permission = ALCANTARA_PERMISSIONS.program.operate;

  it('fails closed when a protected route has no policy metadata', async () => {
    const reflector = {
      getAllAndOverride: jest
        .fn()
        .mockReturnValueOnce(false)
        .mockReturnValueOnce(undefined),
    } as unknown as Reflector;
    const guard = new PompeiiAuthorizationGuard(
      reflector,
      {} as PompeiiService,
    );

    await expect(
      guard.canActivate(context('Bearer token')),
    ).rejects.toBeInstanceOf(InternalServerErrorException);
  });

  it('requires a bearer token before asking Pompeii', async () => {
    const reflector = {
      getAllAndOverride: jest
        .fn()
        .mockReturnValueOnce(false)
        .mockReturnValueOnce(permission),
    } as unknown as Reflector;
    const authorize = jest.fn();
    const guard = new PompeiiAuthorizationGuard(reflector, {
      authorize,
    } as unknown as PompeiiService);

    await expect(guard.canActivate(context())).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(authorize).not.toHaveBeenCalled();
  });

  it('passes the exact permission and bearer token to Pompeii', async () => {
    const reflector = {
      getAllAndOverride: jest
        .fn()
        .mockReturnValueOnce(false)
        .mockReturnValueOnce(permission),
    } as unknown as Reflector;
    const authorize = jest.fn().mockResolvedValue({
      authenticated: true,
      allowed: true,
      reason: 'ALLOW',
      subject: 'cognito-subject',
      effectivePermissions: [permission],
      roles: ['operator'],
    });
    const guard = new PompeiiAuthorizationGuard(reflector, {
      authorize,
      teamId: 42,
    } as unknown as PompeiiService);

    const request = {
      headers: { authorization: 'Bearer token' },
      user: {} as Record<string, unknown>,
    };
    const authContext = {
      getHandler: () => function handler() {},
      getClass: () => class Controller {},
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext;

    await expect(guard.canActivate(authContext)).resolves.toBe(true);
    expect(authorize).toHaveBeenCalledWith('Bearer token', permission);
    expect(request.user).toMatchObject({
      sub: 'cognito-subject',
      authorization: { permission, teamId: 42 },
    });
  });

  it('rejects authenticated denials', async () => {
    const reflector = {
      getAllAndOverride: jest
        .fn()
        .mockReturnValueOnce(false)
        .mockReturnValueOnce(permission),
    } as unknown as Reflector;
    const guard = new PompeiiAuthorizationGuard(reflector, {
      authorize: jest.fn().mockResolvedValue({
        authenticated: true,
        allowed: false,
        reason: 'DENY_NO_PERMISSION',
      }),
    } as unknown as PompeiiService);

    await expect(
      guard.canActivate(context('Bearer token')),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rejects tokens Pompeii did not authenticate', async () => {
    const reflector = {
      getAllAndOverride: jest
        .fn()
        .mockReturnValueOnce(false)
        .mockReturnValueOnce(permission),
    } as unknown as Reflector;
    const guard = new PompeiiAuthorizationGuard(reflector, {
      authorize: jest.fn().mockResolvedValue({
        authenticated: false,
        allowed: false,
        reason: 'DENY_INVALID_TOKEN',
      }),
    } as unknown as PompeiiService);

    await expect(
      guard.canActivate(context('Bearer invalid')),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects an allow response without an authenticated subject', async () => {
    const reflector = {
      getAllAndOverride: jest
        .fn()
        .mockReturnValueOnce(false)
        .mockReturnValueOnce(permission),
    } as unknown as Reflector;
    const guard = new PompeiiAuthorizationGuard(reflector, {
      authorize: jest.fn().mockResolvedValue({
        authenticated: true,
        allowed: true,
        subject: ' ',
        reason: 'ALLOW',
        effectivePermissions: [permission],
        roles: [],
      }),
    } as unknown as PompeiiService);

    await expect(
      guard.canActivate(context('Bearer token')),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('bypasses only routes explicitly marked public', async () => {
    const reflector = {
      getAllAndOverride: jest.fn().mockReturnValue(true),
    } as unknown as Reflector;
    const authorize = jest.fn();
    const guard = new PompeiiAuthorizationGuard(reflector, {
      authorize,
    } as unknown as PompeiiService);

    await expect(guard.canActivate(context())).resolves.toBe(true);
    expect(authorize).not.toHaveBeenCalled();
  });

  it('does not convert Pompeii outages into an allow', async () => {
    const reflector = {
      getAllAndOverride: jest
        .fn()
        .mockReturnValueOnce(false)
        .mockReturnValueOnce(permission),
    } as unknown as Reflector;
    const guard = new PompeiiAuthorizationGuard(reflector, {
      authorize: jest.fn().mockRejectedValue(new ServiceUnavailableException()),
    } as unknown as PompeiiService);

    await expect(
      guard.canActivate(context('Bearer token')),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
