import 'reflect-metadata';

// Exercise the `design:paramtypes` fallback to `Object` that TypeScript emits
// when a constructor dependency is unresolved at decoration time.
jest.mock('./radio-metrics.service', () => ({
  RadioMetricsService: undefined,
}));

import { RadioOutputConfidenceService } from './radio-output-confidence.service';

describe('RadioOutputConfidenceService constructor metadata', () => {
  it('falls back to Object parameter types when dependencies are unresolved', () => {
    expect(
      Reflect.getMetadata('design:paramtypes', RadioOutputConfidenceService),
    ).toEqual([Object]);
  });
});
