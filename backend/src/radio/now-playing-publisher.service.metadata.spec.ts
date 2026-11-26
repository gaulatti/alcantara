import 'reflect-metadata';

// The emitted `design:paramtypes` metadata falls back to `Object` when a
// constructor dependency is not a function at decoration time (for example a
// circular import that has not resolved yet). Mock the dependency modules away
// so that fallback is exercised for real.
jest.mock('./playout-song-scope', () => ({ PlayoutSongScope: undefined }));
jest.mock('../prisma.service', () => ({ PrismaService: undefined }));
jest.mock('../observability/managed-metrics.service', () => ({
  ManagedMetricsService: undefined,
}));
jest.mock('@nestjs/config', () => ({ ConfigService: undefined }));

import { NowPlayingPublisherService } from './now-playing-publisher.service';

describe('NowPlayingPublisherService constructor metadata', () => {
  it('falls back to Object parameter types when dependencies are unresolved', () => {
    expect(
      Reflect.getMetadata('design:paramtypes', NowPlayingPublisherService),
    ).toEqual([Object, Object, Object, Object]);
  });
});
