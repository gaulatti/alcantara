/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/unbound-method */
import { ALCANTARA_PERMISSIONS } from '../auth/permissions';
import { REQUIRED_PERMISSION_KEY } from '../auth/require-permission.decorator';
import { ExternalSourceMetricsInterceptor } from './external-source-metrics.interceptor';
import { ExternalSourcesController } from './external-sources.controller';
import type { ExternalSourcesService } from './external-sources.service';

describe('ExternalSourcesController coverage', () => {
  const service = {
    list: jest.fn(),
    get: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    rotateCredential: jest.fn(),
    validateRedirect: jest.fn(),
    reconcile: jest.fn(),
    revoke: jest.fn(),
  };
  const controller = new ExternalSourcesController(
    service as unknown as ExternalSourcesService,
  );
  const authorization = { teamId: 4, permissions: ['p'] };
  const request = { user: { sub: 'operator', authorization } };

  beforeEach(() => jest.resetAllMocks());

  it('requires read at class level and operate for every mutation', () => {
    const prototype = ExternalSourcesController.prototype;
    expect(
      Reflect.getMetadata(REQUIRED_PERMISSION_KEY, ExternalSourcesController),
    ).toBe(ALCANTARA_PERMISSIONS.webrtc.read);
    for (const method of [
      prototype.create,
      prototype.update,
      prototype.rotate,
      prototype.redirect,
      prototype.reconcile,
      prototype.revoke,
    ]) {
      expect(Reflect.getMetadata(REQUIRED_PERMISSION_KEY, method)).toBe(
        ALCANTARA_PERMISSIONS.webrtc.operate,
      );
    }
    expect(
      Reflect.getMetadata(REQUIRED_PERMISSION_KEY, prototype.list),
    ).toBeUndefined();
    expect(
      Reflect.getMetadata('__interceptors__', ExternalSourcesController),
    ).toEqual([ExternalSourceMetricsInterceptor]);
  });

  it('scopes reads to the caller authorization', async () => {
    service.list.mockResolvedValue(['a']);
    service.get.mockResolvedValue({ id: 'a' });
    await expect(controller.list(request)).resolves.toEqual(['a']);
    await expect(controller.get('a', request)).resolves.toEqual({ id: 'a' });
    expect(service.list).toHaveBeenCalledWith(authorization);
    expect(service.get).toHaveBeenCalledWith('a', authorization);
  });

  it('passes the subject, body and authorization to mutations', async () => {
    service.create.mockResolvedValue('created');
    service.update.mockResolvedValue('updated');
    service.rotateCredential.mockResolvedValue('rotated');
    service.validateRedirect.mockResolvedValue('validated');
    service.reconcile.mockResolvedValue('reconciled');
    service.revoke.mockResolvedValue('revoked');
    const body = { name: 'x', url: 'https://example.com' };

    await expect(controller.create(body, request)).resolves.toBe('created');
    expect(service.create).toHaveBeenCalledWith(
      'operator',
      body,
      authorization,
    );
    await expect(controller.update('a', body, request)).resolves.toBe(
      'updated',
    );
    expect(service.update).toHaveBeenCalledWith('a', body, authorization);
    await expect(controller.rotate('a', request)).resolves.toBe('rotated');
    expect(service.rotateCredential).toHaveBeenCalledWith('a', authorization);
    await expect(controller.redirect('a', body, request)).resolves.toBe(
      'validated',
    );
    expect(service.validateRedirect).toHaveBeenCalledWith(
      'a',
      'https://example.com',
      authorization,
    );
    await expect(controller.reconcile('a', body, request)).resolves.toBe(
      'reconciled',
    );
    expect(service.reconcile).toHaveBeenCalledWith('a', body, authorization);
    await expect(controller.revoke('a', request)).resolves.toBe('revoked');
    expect(service.revoke).toHaveBeenCalledWith('a', authorization);
  });

  it('records decorator metadata fallbacks when referenced types are not constructors', () => {
    class FakeRecord {}
    const holder = globalThis as unknown as { Record?: unknown };
    jest.isolateModules(() => {
      jest.doMock('./external-sources.service', () => ({
        ExternalSourcesService: undefined,
      }));
      const { ExternalSourcesController: Isolated } =
        require('./external-sources.controller') as {
          ExternalSourcesController: { prototype: object };
        };
      expect(Reflect.getMetadata('design:paramtypes', Isolated)).toEqual([
        Object,
      ]);
      expect(
        Reflect.getMetadata('design:paramtypes', Isolated.prototype, 'create'),
      ).toEqual([Object, Object]);
    });
    jest.resetModules();

    holder.Record = FakeRecord;
    try {
      jest.isolateModules(() => {
        const { ExternalSourcesController: Isolated } =
          require('./external-sources.controller') as {
            ExternalSourcesController: { prototype: object };
          };
        for (const method of ['create', 'update', 'redirect', 'reconcile']) {
          expect(
            Reflect.getMetadata(
              'design:paramtypes',
              Isolated.prototype,
              method,
            ) as unknown[],
          ).toContain(FakeRecord);
        }
      });
    } finally {
      delete holder.Record;
      jest.resetModules();
    }
  });
});
