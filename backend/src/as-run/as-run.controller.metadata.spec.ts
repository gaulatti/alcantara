/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument -- metadata tests reflect unresolved tokens */
describe('AsRunController decorator metadata', () => {
  afterEach(() => {
    jest.dontMock('./as-run.service');
  });

  it('records Object for the constructor type when AsRunService is unresolved', () => {
    jest.isolateModules(() => {
      jest.doMock('./as-run.service', () => ({}));
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { AsRunController } = require('./as-run.controller');
      expect(Reflect.getMetadata('design:paramtypes', AsRunController)).toEqual(
        [Object],
      );
    });
  });

  it('records Object as the handler return type when Promise is unavailable', () => {
    const realPromise = globalThis.Promise;
    let returnType: unknown;
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { AsRunController } = require('./as-run.controller');
      returnType = Reflect.getMetadata(
        'design:returntype',
        AsRunController.prototype,
        'export',
      );
    });
    expect(returnType).toBe(realPromise);

    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('@nestjs/common');
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('./as-run.service');
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('../auth/permissions');
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('../auth/require-permission.decorator');
      (globalThis as { Promise?: unknown }).Promise = undefined;
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { AsRunController } = require('./as-run.controller');
        returnType = Reflect.getMetadata(
          'design:returntype',
          AsRunController.prototype,
          'export',
        );
      } finally {
        globalThis.Promise = realPromise;
      }
    });
    expect(returnType).toBe(Object);
  });
});
