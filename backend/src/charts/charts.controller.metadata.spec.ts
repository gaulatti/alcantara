/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument -- Jest mocks are intentionally loosely typed. */
describe('ChartsController decorator metadata', () => {
  afterEach(() => {
    jest.dontMock('./charts.service');
  });

  it('records Object for the constructor type when the ChartsService token is unresolved', () => {
    jest.isolateModules(() => {
      jest.doMock('./charts.service', () => ({}));
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { ChartsController } = require('./charts.controller');
      expect(
        Reflect.getMetadata('design:paramtypes', ChartsController),
      ).toEqual([Object]);
    });
  });

  it('records Object as the handler return type when Promise is unavailable', () => {
    const realPromise = globalThis.Promise;
    let returnType: unknown;
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { ChartsController } = require('./charts.controller');
      returnType = Reflect.getMetadata(
        'design:returntype',
        ChartsController.prototype,
        'getSanremoRealtime',
      );
    });
    expect(returnType).toBe(realPromise);

    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('@nestjs/common');
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('./charts.service');
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('../auth/public.decorator');
      (globalThis as { Promise?: unknown }).Promise = undefined;
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { ChartsController } = require('./charts.controller');
        returnType = Reflect.getMetadata(
          'design:returntype',
          ChartsController.prototype,
          'getSanremoRealtime',
        );
      } finally {
        globalThis.Promise = realPromise;
      }
    });
    expect(returnType).toBe(Object);
  });
});
