import 'reflect-metadata';

// Exercise the `design:paramtypes` fallback to `Object` that TypeScript emits
// when a constructor dependency is unresolved at decoration time.
jest.mock('./playout-song-scope', () => ({ PlayoutSongScope: undefined }));
jest.mock('../prisma.service', () => ({ PrismaService: undefined }));
jest.mock('../auth/pompeii.service', () => ({ PompeiiService: undefined }));
jest.mock('@nestjs/config', () => ({ ConfigService: undefined }));
jest.mock('./radio-metrics.service', () => ({
  RadioMetricsService: undefined,
}));
jest.mock('../observability/managed-metrics.service', () => ({
  ManagedMetricsService: undefined,
}));
jest.mock('../tenancy/program-team-access', () => ({ ProgramTeamAccess: undefined }));
jest.mock('./palazzo-machine.client', () => ({
  PalazzoMachineClient: undefined,
  PalazzoMachineError: class PalazzoMachineError extends Error {},
}));

import { RadioService } from './radio.service';

describe('RadioService constructor metadata', () => {
  it('falls back to Object parameter types when dependencies are unresolved', () => {
    expect(Reflect.getMetadata('design:paramtypes', RadioService)).toEqual([
      Object,
      Object,
      Object,
      Object,
      Object,
      Object,
      Object,
      Object,
    ]);
  });
});
