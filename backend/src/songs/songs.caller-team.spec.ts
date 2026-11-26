import { IS_PUBLIC_KEY } from '../auth/public.decorator';
import { REQUIRED_PERMISSION_KEY } from '../auth/require-permission.decorator';
import { SongsController } from './songs.controller';

// gaulatti/alcantara#122: every team-scoped handler is behind the authorization
// guard, which is what puts the caller's team on the request. None is public.
describe('SongsController team-scoped handlers', () => {
  it.each(['findAll', 'findOne', 'create', 'update', 'remove'] as const)(
    '%s requires authorization',
    (name) => {
      const handler = SongsController.prototype[name];
      for (const target of [handler, SongsController]) {
        expect(Reflect.getMetadata(IS_PUBLIC_KEY, target)).toBeUndefined();
      }
      expect(
        Reflect.getMetadata(REQUIRED_PERMISSION_KEY, handler) ??
          Reflect.getMetadata(REQUIRED_PERMISSION_KEY, SongsController),
      ).toBeDefined();
    },
  );
});
