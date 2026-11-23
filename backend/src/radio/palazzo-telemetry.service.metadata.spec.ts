import 'reflect-metadata';

// Exercise the `design:paramtypes` fallback to `Object` that TypeScript emits
// when a constructor dependency is unresolved at decoration time.
jest.mock('../prisma.service', () => ({ PrismaService: undefined }));
jest.mock('./radio-metrics.service', () => ({
  RadioMetricsService: undefined,
}));
jest.mock('./palazzo-machine.client', () => ({
  PalazzoMachineClient: undefined,
}));
jest.mock('./song-execution.engine', () => ({
  SongExecutionEngine: undefined,
}));

import { PalazzoRadioTelemetryService } from './palazzo-telemetry.service';

describe('PalazzoRadioTelemetryService constructor metadata', () => {
  it('falls back to Object parameter types when dependencies are unresolved', () => {
    expect(
      Reflect.getMetadata('design:paramtypes', PalazzoRadioTelemetryService),
    ).toEqual([Object, Object, Object, Object]);
  });
});
