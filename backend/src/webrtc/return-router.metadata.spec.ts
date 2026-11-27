import 'reflect-metadata';

// Exercise the `design:paramtypes` fallbacks to `Object` that TypeScript emits when a referenced class is
// unresolved at decoration time, for the return router's service and controller.
jest.mock('./webrtc.service', () => ({ WebrtcService: undefined }));
jest.mock('../radio/radio-monitor.service', () => ({
  RadioMonitorService: undefined,
}));
jest.mock('../observability/managed-metrics.service', () => ({
  ManagedMetricsService: undefined,
}));
jest.mock('./return-router.service', () => ({
  ReturnRouterService: undefined,
}));

describe('return router metadata', () => {
  it('falls back to Object metadata when its dependencies are unresolved', () => {
    let service: typeof import('./return-router.service');
    let controller: typeof import('./return-router.controller');
    jest.isolateModules(() => {
      service = jest.requireActual('./return-router.service');
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      controller = require('./return-router.controller');
    });
    expect(
      Reflect.getMetadata('design:paramtypes', service!.ReturnRouterService),
    ).toEqual([Object, Object, Object]);
    expect(
      Reflect.getMetadata(
        'design:paramtypes',
        controller!.ReturnRouterController,
      ),
    ).toEqual([Object, Object]);
  });

  it('reflects the ticket body as Record when a global Record exists', () => {
    const globals = globalThis as Record<string, unknown>;
    const original = globals.Record;
    class RecordStub {}
    globals.Record = RecordStub;
    try {
      jest.isolateModules(() => {
        const { ReturnRouterController } =
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          require('./return-router.controller') as typeof import('./return-router.controller');
        expect(
          Reflect.getMetadata(
            'design:paramtypes',
            ReturnRouterController.prototype,
            'audioTicket',
          ),
        ).toEqual([Object, RecordStub]);
      });
    } finally {
      if (original === undefined) delete globals.Record;
      else globals.Record = original;
    }
  });
});
