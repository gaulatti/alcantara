import 'reflect-metadata';

// The `design:paramtypes` fallbacks to `Object` TypeScript emits when a referenced class is unresolved at decoration
// time, for the playout lease and the readiness controller.
describe('playout decorator metadata', () => {
  afterEach(() => {
    jest.dontMock('../observability/managed-metrics.service');
    jest.dontMock('./playout-lease.service');
  });

  it('falls back to Object when the dependency classes are unresolved', () => {
    jest.doMock('../observability/managed-metrics.service', () => ({
      ManagedMetricsService: undefined,
    }));
    jest.doMock('./playout-lease.service', () => ({ PlayoutLease: undefined }));
    jest.isolateModules(() => {
      const { PlayoutLease } = jest.requireActual<
        typeof import('./playout-lease.service')
      >('./playout-lease.service');

      const { HealthController } =
        require('./health.controller') as typeof import('./health.controller');
      expect(Reflect.getMetadata('design:paramtypes', PlayoutLease)).toEqual([
        Object,
        Object,
      ]);
      expect(
        Reflect.getMetadata('design:paramtypes', HealthController),
      ).toEqual([Object]);
    });
  });

  it('reflects the options as Partial when a global Partial exists', () => {
    const globals = globalThis as Record<string, unknown>;
    class PartialStub {}
    globals.Partial = PartialStub;
    try {
      jest.isolateModules(() => {
        const { PlayoutLease } = jest.requireActual<
          typeof import('./playout-lease.service')
        >('./playout-lease.service');
        const types = Reflect.getMetadata(
          'design:paramtypes',
          PlayoutLease,
        ) as unknown[];
        expect(types[1]).toBe(PartialStub);
      });
    } finally {
      delete globals.Partial;
    }
  });
});
