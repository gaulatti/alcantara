import 'reflect-metadata';

// Exercise the `design:paramtypes` / `design:returntype` fallbacks to `Object`
// that TypeScript emits when a referenced class is unresolved at decoration
// time.
jest.mock('./radio-monitor.service', () => ({
  RadioMonitorService: undefined,
}));

type ControllerModule = typeof import('./radio-monitor.controller');

describe('RadioMonitorController metadata', () => {
  it('falls back to Object metadata when dependencies and Promise are unresolved', () => {
    const globals = globalThis as { Promise?: PromiseConstructor };
    const originalPromise = globals.Promise;
    let loaded: ControllerModule;
    jest.isolateModules(() => {
      globals.Promise = undefined;
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        loaded = require('./radio-monitor.controller') as ControllerModule;
      } finally {
        globals.Promise = originalPromise;
      }
    });
    const { RadioMonitorController } = loaded!;
    expect(
      Reflect.getMetadata('design:paramtypes', RadioMonitorController),
    ).toEqual([Object]);
    expect(
      Reflect.getMetadata(
        'design:returntype',
        RadioMonitorController.prototype,
        'audio',
      ),
    ).toBe(Object);
    expect(globals.Promise).toBe(originalPromise);
  });
});
