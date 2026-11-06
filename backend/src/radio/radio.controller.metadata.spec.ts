import 'reflect-metadata';

// Exercise the `design:paramtypes` fallback to `Object` that TypeScript emits
// when a constructor dependency is unresolved at decoration time.
jest.mock('./radio.service', () => ({ RadioService: undefined }));
jest.mock('./song-execution.engine', () => ({
  SongExecutionEngine: undefined,
}));
jest.mock('./now-playing-publisher.service', () => ({
  NowPlayingPublisherService: undefined,
}));
jest.mock('./palazzo-telemetry.service', () => ({
  PalazzoRadioTelemetryService: undefined,
}));
jest.mock('./radio-output-confidence.service', () => ({
  RadioOutputConfidenceService: undefined,
}));

import { RadioController } from './radio.controller';

describe('RadioController constructor metadata', () => {
  it('falls back to Object parameter types when dependencies are unresolved', () => {
    expect(Reflect.getMetadata('design:paramtypes', RadioController)).toEqual([
      Object,
      Object,
      Object,
      Object,
      Object,
    ]);
  });
});
