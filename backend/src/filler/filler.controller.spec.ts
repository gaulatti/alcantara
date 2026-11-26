import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import {
  ALCANTARA_PERMISSIONS,
  type AlcantaraPermission,
} from '../auth/permissions';
import { PompeiiAuthorizationGuard } from '../auth/pompeii-authorization.guard';
import { ObservabilityModule } from '../observability/observability.module';
import { PompeiiService } from '../auth/pompeii.service';
import { PrismaService } from '../prisma.service';
import { PalazzoMachineClient } from '../radio/palazzo-machine.client';
import { FillerController } from './filler.controller';
import { FillerModule } from './filler.module';
import { FillerService } from './filler.service';

// gaulatti/alcantara#126: viewing needs broadcast.view and preparing needs
// broadcast.manage, enforced by the application's real authorization guard.

const { view, operate, manage } = ALCANTARA_PERMISSIONS.broadcast;
const ROLES: Record<string, AlcantaraPermission[]> = {
  viewer: [view],
  operator: [view, operate],
  manager: [view, manage],
};

function guardFor(role: string) {
  const pompeii = {
    teamId: 1,
    authorize: jest.fn((_token: string, permission: AlcantaraPermission) =>
      Promise.resolve({
        authenticated: true,
        allowed: ROLES[role].includes(permission),
        subject: `${role}-1`,
        reason: ROLES[role].includes(permission) ? 'ALLOW' : 'DENY',
        effectivePermissions: ROLES[role],
        roles: [role],
      }),
    ),
  } as unknown as PompeiiService;
  return new PompeiiAuthorizationGuard(new Reflector(), pompeii);
}

const contextFor = (handler: (...args: never[]) => unknown) => {
  const request = { headers: { authorization: 'Bearer test-token' } };
  return {
    context: {
      getHandler: () => handler,
      getClass: () => FillerController,
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext,
    request: request as { user?: { sub: string } },
  };
};

/** The decorated route handler, as the guard sees it through Reflector. */
const handler = (name: keyof FillerController) =>
  Object.getOwnPropertyDescriptor(FillerController.prototype, name)!.value as (
    ...args: never[]
  ) => unknown;

describe('FillerController', () => {
  const service = {
    getState: jest.fn().mockResolvedValue({ legs: {} }),
    prepareTelevision: jest
      .fn()
      .mockResolvedValue({ legs: { television: {} } }),
    prepareRadio: jest.fn().mockResolvedValue({ legs: { radio: {} } }),
  };
  const controller = new FillerController(service as unknown as FillerService);
  const handlers = {
    getState: handler('getState'),
    prepareTelevision: handler('prepareTelevision'),
    prepareRadio: handler('prepareRadio'),
  };

  it.each([
    ['viewer', 'getState', true],
    ['viewer', 'prepareTelevision', false],
    ['viewer', 'prepareRadio', false],
    ['operator', 'getState', true],
    ['operator', 'prepareTelevision', false],
    ['operator', 'prepareRadio', false],
    ['manager', 'getState', true],
    ['manager', 'prepareTelevision', true],
    ['manager', 'prepareRadio', true],
  ] as const)('lets a %s %s: %s', async (role, handler, allowed) => {
    const { context, request } = contextFor(handlers[handler]);
    const decision = guardFor(role).canActivate(context);
    if (allowed) {
      await expect(decision).resolves.toBe(true);
      expect(request.user?.sub).toBe(`${role}-1`);
    } else {
      await expect(decision).rejects.toBeInstanceOf(ForbiddenException);
    }
  });

  it('passes the program, the body and the authenticated subject to the service', async () => {
    const request = { user: { sub: 'manager-1' } };
    await expect(controller.getState('both-1')).resolves.toEqual({ legs: {} });
    await controller.prepareTelevision('both-1', { assetId: 'slate' }, request);
    expect(service.prepareTelevision).toHaveBeenCalledWith(
      'both-1',
      { assetId: 'slate' },
      'manager-1',
    );
    await controller.prepareRadio(
      'both-1',
      { assetIds: ['a'], mode: 'ordered' },
      request,
    );
    expect(service.prepareRadio).toHaveBeenCalledWith(
      'both-1',
      { assetIds: ['a'], mode: 'ordered' },
      'manager-1',
    );
  });

  it('compiles its module with the global Palazzo client', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ ignoreEnvFile: true, isGlobal: true }),
        ObservabilityModule,
        FillerModule,
      ],
    })
      .overrideProvider(PrismaService)
      .useValue({})
      .useMocker((token) =>
        token === PalazzoMachineClient || token === PompeiiService
          ? {}
          : undefined,
      )
      .compile();
    expect(moduleRef.get(FillerController)).toBeInstanceOf(FillerController);
    expect(moduleRef.get(FillerService)).toBeInstanceOf(FillerService);
    await moduleRef.close();
  });
});
