import { TestAuthController } from './test-auth.controller';
import { assertTestAuthConfiguration } from './test-auth';

describe('local test authentication', () => {
  const original = { ...process.env };
  afterEach(() => { process.env = { ...original }; });

  it('refuses test auth in production', () => {
    process.env.AUTH_MODE = 'test';
    process.env.NODE_ENV = 'production';
    process.env.TEST_AUTH_SECRET = 'a'.repeat(32);
    expect(() => assertTestAuthConfiguration()).toThrow('must never run');
  });

  it('hides the session endpoint when disabled', () => {
    delete process.env.AUTH_MODE;
    expect(() => new TestAuthController().session('admin')).toThrow();
  });

  it('issues distinct short-lived seeded profiles', () => {
    process.env.AUTH_MODE = 'test';
    process.env.NODE_ENV = 'development';
    process.env.TEST_AUTH_SECRET = 'a'.repeat(32);
    const controller = new TestAuthController();
    const viewer = controller.session('viewer');
    const denied = controller.session('denied');
    expect(viewer.profile).toBe('viewer');
    expect(denied.profile).toBe('denied');
    expect(viewer.user.sub).not.toBe(denied.user.sub);
  });
});
