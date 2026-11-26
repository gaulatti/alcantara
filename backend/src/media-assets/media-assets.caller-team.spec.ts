import { ForbiddenException } from '@nestjs/common';
import { IS_PUBLIC_KEY } from '../auth/public.decorator';
import { MediaAssetsController } from './media-assets.controller';

// gaulatti/alcantara#122: every team-scoped handler is behind the authorization
// guard and refuses a request that names no team. Only the label images a
// programme page shows are public, and they are not scoped.
describe('MediaAssetsController team-scoped handlers', () => {
  const handlers = Object.getOwnPropertyNames(
    MediaAssetsController.prototype,
  ).filter(
    (name) =>
      name !== 'constructor' &&
      name !== 'authorizationOf' &&
      name !== 'resolveLabelImages',
  );

  it('are all behind the guard', () => {
    expect(handlers).toHaveLength(11);
    for (const name of handlers) {
      const handler = (
        MediaAssetsController.prototype as unknown as Record<string, object>
      )[name];
      expect(Reflect.getMetadata(IS_PUBLIC_KEY, handler)).toBeUndefined();
    }
  });

  it('refuses a request without a team with 403 before the service', () => {
    const service = { findOne: jest.fn() };
    const controller = new MediaAssetsController(service as never);
    expect(() =>
      controller.findOne('a', {
        user: { authorization: { permissions: [] } },
      }),
    ).toThrow(ForbiddenException);
    expect(service.findOne).not.toHaveBeenCalled();
  });
});
