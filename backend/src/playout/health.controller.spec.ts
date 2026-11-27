import { HealthController } from './health.controller';
import { PlayoutModule } from './playout.module';
import { PlayoutLease } from './playout-lease.service';

describe('HealthController', () => {
  it('reports the playout state and the build', () => {
    const saved = process.env.ALCANTARA_BUILD_VERSION;
    try {
      process.env.ALCANTARA_BUILD_VERSION = 'fictional-sha';
      expect(
        new HealthController({
          current: 'standby',
          timeline: { grantedAt: null, activeSince: null },
        } as PlayoutLease).ready(),
      ).toEqual({
        state: 'standby',
        build: 'fictional-sha',
        grantedAt: null,
        activeSince: null,
      });
      delete process.env.ALCANTARA_BUILD_VERSION;
      expect(
        new HealthController({
          current: 'active',
          timeline: {
            grantedAt: '2026-11-27T08:15:54.700Z',
            activeSince: '2026-11-27T08:15:55.050Z',
          },
        } as PlayoutLease).ready(),
      ).toEqual({
        state: 'active',
        build: null,
        grantedAt: '2026-11-27T08:15:54.700Z',
        activeSince: '2026-11-27T08:15:55.050Z',
      });
    } finally {
      if (saved === undefined) delete process.env.ALCANTARA_BUILD_VERSION;
      else process.env.ALCANTARA_BUILD_VERSION = saved;
    }
  });

  it('is registered by the global playout module with the lease', () => {
    expect(Reflect.getMetadata('controllers', PlayoutModule)).toEqual([
      HealthController,
    ]);
    expect(Reflect.getMetadata('providers', PlayoutModule)).toEqual([
      PlayoutLease,
    ]);
    expect(Reflect.getMetadata('exports', PlayoutModule)).toEqual([
      PlayoutLease,
    ]);
  });
});
