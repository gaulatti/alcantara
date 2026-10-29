import { TestAuthController } from './test-auth.controller';
import { TestAuthService } from './test-auth.service';
import { IS_PUBLIC_KEY } from './public.decorator';

describe('TestAuthController', () => {
  it('issues a session for the requested identity', () => {
    const session = { accessToken: 'abc' };
    const testAuth = { issue: jest.fn().mockReturnValue(session) };
    const controller = new TestAuthController(
      testAuth as unknown as TestAuthService,
    );
    expect(controller.session('viewer')).toBe(session);
    expect(testAuth.issue).toHaveBeenCalledWith('viewer');
    controller.session();
    expect(testAuth.issue).toHaveBeenLastCalledWith(undefined);
  });

  it('is a public route', () => {
    expect(
      Reflect.getMetadata(IS_PUBLIC_KEY, TestAuthController.prototype.session),
    ).toBe(true);
  });

  it('records Object for the service dependency when its module is not yet defined', () => {
    jest.isolateModules(() => {
      jest.doMock('./test-auth.service', () => ({}));
      const {
        TestAuthController: Isolated,
      } = require('./test-auth.controller');
      expect(Reflect.getMetadata('design:paramtypes', Isolated)).toEqual([
        Object,
      ]);
    });
  });
});
