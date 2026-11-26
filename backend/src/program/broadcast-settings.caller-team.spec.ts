import { IS_PUBLIC_KEY } from '../auth/public.decorator';
import { REQUIRED_PERMISSION_KEY } from '../auth/require-permission.decorator';
import { ProgramController } from './program.controller';

// gaulatti/alcantara#122: every team-scoped handler is behind the authorization
// guard, which is what puts the caller's team on the request. None is public.
describe('ProgramController team-scoped handlers', () => {
  it.each(['updateBroadcastSettings'] as const)(
    '%s requires authorization',
    (name) => {
      const handler = ProgramController.prototype[name];
      for (const target of [handler, ProgramController]) {
        expect(Reflect.getMetadata(IS_PUBLIC_KEY, target)).toBeUndefined();
      }
      expect(
        Reflect.getMetadata(REQUIRED_PERMISSION_KEY, handler) ??
          Reflect.getMetadata(REQUIRED_PERMISSION_KEY, ProgramController),
      ).toBeDefined();
    },
  );
});
