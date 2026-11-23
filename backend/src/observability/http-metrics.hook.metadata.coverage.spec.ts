/* eslint-disable @typescript-eslint/no-require-imports */
describe('HttpMetricsHook decorator metadata', () => {
  afterEach(() => jest.resetModules());

  it('falls back to Object when collaborator classes are undefined at decoration time', () => {
    jest.isolateModules(() => {
      jest.doMock('@nestjs/core', () => ({
        ...jest.requireActual<object>('@nestjs/core'),
        HttpAdapterHost: undefined,
      }));
      jest.doMock('./managed-metrics.service', () => ({
        ManagedMetricsService: undefined,
      }));
      const { HttpMetricsHook } = require('./http-metrics.hook') as {
        HttpMetricsHook: new (...args: never[]) => unknown;
      };
      const types = Reflect.getMetadata(
        'design:paramtypes',
        HttpMetricsHook,
      ) as unknown[];
      expect(types).toEqual([Object, Object]);
    });
  });
});
