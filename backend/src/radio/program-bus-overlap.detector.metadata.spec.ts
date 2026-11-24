import 'reflect-metadata';

// Exercise the `design:paramtypes` fallback to `Object` that TypeScript emits
// when a constructor dependency is unresolved at decoration time.
jest.mock('../prisma.service', () => ({ PrismaService: undefined }));
jest.mock('./radio-metrics.service', () => ({
  RadioMetricsService: undefined,
}));

import { ProgramBusOverlapDetector } from './program-bus-overlap.detector';

describe('ProgramBusOverlapDetector constructor metadata', () => {
  it('falls back to Object parameter types when dependencies are unresolved', () => {
    expect(
      Reflect.getMetadata('design:paramtypes', ProgramBusOverlapDetector),
    ).toEqual([Object, Object]);
  });
});
