import 'reflect-metadata';

// Exercise the `design:paramtypes` fallback to `Object` that TypeScript emits
// when a constructor dependency is unresolved at decoration time.
jest.mock('@nestjs/config', () => ({ ConfigService: undefined }));
jest.mock('./radio-metrics.service', () => ({
  RadioMetricsService: undefined,
}));

import { PalazzoMachineClient } from './palazzo-machine.client';

describe('PalazzoMachineClient constructor metadata', () => {
  it('falls back to Object parameter types when dependencies are unresolved', () => {
    expect(
      Reflect.getMetadata('design:paramtypes', PalazzoMachineClient),
    ).toEqual([Object, Object, Object]);
  });
});
