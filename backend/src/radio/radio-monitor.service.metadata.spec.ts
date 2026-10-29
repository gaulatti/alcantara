import 'reflect-metadata';

// Exercise the `design:paramtypes` fallback to `Object` that TypeScript emits
// when a constructor dependency is unresolved at decoration time.
jest.mock('./radio.service', () => ({ RadioService: undefined }));
jest.mock('./radio-metrics.service', () => ({
  RadioMetricsService: undefined,
}));
jest.mock('./palazzo-machine.client', () => ({
  PalazzoMachineClient: undefined,
}));

import { RadioMonitorService } from './radio-monitor.service';

describe('RadioMonitorService constructor metadata', () => {
  it('falls back to Object parameter types when dependencies are unresolved', () => {
    expect(
      Reflect.getMetadata('design:paramtypes', RadioMonitorService),
    ).toEqual([Object, Object, Object]);
  });
});
