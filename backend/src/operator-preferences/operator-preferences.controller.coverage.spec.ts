import { ALCANTARA_PERMISSIONS } from '../auth/permissions';
import { REQUIRED_PERMISSION_KEY } from '../auth/require-permission.decorator';
import { OperatorPreferencesController } from './operator-preferences.controller';

const authorization = { permissions: ['alcantara:access'], teamId: 4 };
const request = {
  user: { sub: 'pool-subject', principalId: null, authorization },
};
const identity = { subject: 'pool-subject', principalId: null };

function setup() {
  const preferences = {
    discover: jest.fn().mockReturnValue('discovered'),
    publish: jest.fn().mockReturnValue('published'),
    load: jest.fn().mockReturnValue('loaded'),
    retire: jest.fn().mockReturnValue('retired'),
    get: jest.fn().mockReturnValue('got'),
    save: jest.fn().mockReturnValue('saved'),
    reset: jest.fn().mockReturnValue('reset'),
  };
  return {
    preferences,
    controller: new OperatorPreferencesController(preferences as never),
  };
}

describe('OperatorPreferencesController routing', () => {
  it('discovers shared layouts by scope with the caller authorization', () => {
    const { controller, preferences } = setup();
    expect(controller.discover('team', '4', request)).toBe('discovered');
    expect(preferences.discover).toHaveBeenCalledWith(
      'team',
      '4',
      authorization,
    );
  });

  it('loads a shared layout for the caller identity', () => {
    const { controller, preferences } = setup();
    const body = { deviceClass: 'desktop', version: 2 };
    expect(controller.load('layout-1', body, request)).toBe('loaded');
    expect(preferences.load).toHaveBeenCalledWith(
      identity,
      'layout-1',
      body,
      authorization,
    );
  });

  it('retires a shared layout without a caller identity', () => {
    const { controller, preferences } = setup();
    expect(controller.retire('layout-1', request)).toBe('retired');
    expect(preferences.retire).toHaveBeenCalledWith('layout-1', authorization);
  });

  it('saves a private profile', () => {
    const { controller, preferences } = setup();
    const body = { version: 1, profile: { workspace: 'audio' } };
    expect(controller.save('tablet', body, request)).toBe('saved');
    expect(preferences.save).toHaveBeenCalledWith(identity, 'tablet', body);
  });

  it('resets one device class or everything', () => {
    const { controller, preferences } = setup();
    expect(controller.resetClass('phone', request)).toBe('reset');
    expect(preferences.reset).toHaveBeenLastCalledWith(identity, 'phone');
    expect(controller.resetAll(request)).toBe('reset');
    expect(preferences.reset).toHaveBeenLastCalledWith(identity);
  });

  it('carries a resolved principal into the identity', () => {
    const { controller, preferences } = setup();
    controller.get('desktop', {
      user: { ...request.user, principalId: 'principal-z' },
    });
    expect(preferences.get).toHaveBeenCalledWith(
      { subject: 'pool-subject', principalId: 'principal-z' },
      'desktop',
    );
  });

  it('requires access on the controller and layout management on shared writes', () => {
    expect(
      Reflect.getMetadata(
        REQUIRED_PERMISSION_KEY,
        OperatorPreferencesController,
      ),
    ).toBe(ALCANTARA_PERMISSIONS.access);
    const proto = OperatorPreferencesController.prototype;
    expect(Reflect.getMetadata(REQUIRED_PERMISSION_KEY, proto.publish)).toBe(
      ALCANTARA_PERMISSIONS.layout.manage,
    );
    expect(Reflect.getMetadata(REQUIRED_PERMISSION_KEY, proto.retire)).toBe(
      ALCANTARA_PERMISSIONS.layout.manage,
    );
    expect(
      Reflect.getMetadata(REQUIRED_PERMISSION_KEY, proto.get),
    ).toBeUndefined();
  });

  it('records Object for the service dependency when its module is not yet defined', () => {
    jest.isolateModules(() => {
      jest.doMock('./operator-preferences.service', () => ({}));
      const {
        OperatorPreferencesController: Isolated,
      } = require('./operator-preferences.controller');
      expect(Reflect.getMetadata('design:paramtypes', Isolated)).toEqual([
        Object,
      ]);
    });
  });

  it('records a runtime Record binding in design metadata when one exists at decoration time', () => {
    // `Record<string, unknown>` has no runtime value, so TypeScript emits
    // `typeof Record === "function" ? Record : Object`; the first branch only
    // runs when some global named Record is a function.
    const globals = globalThis as { Record?: unknown };
    const hadRecord = 'Record' in globals;
    const original = globals.Record;
    class FakeRecord {}
    globals.Record = FakeRecord;
    try {
      jest.isolateModules(() => {
        const {
          OperatorPreferencesController: Isolated,
        } = require('./operator-preferences.controller');
        expect(
          Reflect.getMetadata(
            'design:paramtypes',
            Isolated.prototype,
            'publish',
          ),
        ).toEqual([FakeRecord, Object]);
      });
    } finally {
      if (hadRecord) globals.Record = original;
      else delete globals.Record;
    }
  });
});
