import { HealthController } from './health.controller';
import { PlayoutModule } from './playout.module';
import { PlayoutLease } from './playout-lease.service';

describe('HealthController', () => {
  it('reports the playout state and the build', () => {
    const saved = process.env.ALCANTARA_BUILD_VERSION;
    try {
      process.env.ALCANTARA_BUILD_VERSION = 'fictional-sha';
      expect(
        new HealthController({ current: 'standby' } as PlayoutLease).ready(),
      ).toEqual({ state: 'standby', build: 'fictional-sha' });
      delete process.env.ALCANTARA_BUILD_VERSION;
      expect(
        new HealthController({ current: 'active' } as PlayoutLease).ready(),
      ).toEqual({ state: 'active', build: null });
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
