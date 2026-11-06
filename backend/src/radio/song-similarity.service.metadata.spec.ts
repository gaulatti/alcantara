import 'reflect-metadata';

// Exercise the `design:paramtypes` fallback to `Object` that TypeScript emits
// when a constructor dependency is unresolved at decoration time.
jest.mock('../prisma.service', () => ({ PrismaService: undefined }));
jest.mock('./radio-metrics.service', () => ({
  RadioMetricsService: undefined,
}));

import { SongSimilarityService } from './song-similarity.service';

describe('SongSimilarityService constructor metadata', () => {
  it('falls back to Object parameter types when dependencies are unresolved', () => {
    expect(
      Reflect.getMetadata('design:paramtypes', SongSimilarityService),
    ).toEqual([Object, Object]);
  });
});
