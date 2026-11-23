import { Global, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { OperatorPreferencesModule } from './operator-preferences.module';
import { OperatorPreferencesController } from './operator-preferences.controller';
import { OperatorPreferencesService } from './operator-preferences.service';
import { PrismaService } from '../prisma.service';
import { PompeiiService } from '../auth/pompeii.service';
import { ManagedMetricsService } from '../observability/managed-metrics.service';

const metrics = { recordDomain: jest.fn() };

@Global()
@Module({
  providers: [
    { provide: ManagedMetricsService, useValue: metrics },
    { provide: PompeiiService, useValue: { teamId: 7 } },
  ],
  exports: [ManagedMetricsService, PompeiiService],
})
class PlatformMetricsStubModule {}

describe('OperatorPreferencesModule wiring', () => {
  it('resolves the controller and service with the prisma and metrics providers', async () => {
    const prisma = {};
    const moduleRef = await Test.createTestingModule({
      imports: [PlatformMetricsStubModule, OperatorPreferencesModule],
    })
      .overrideProvider(PrismaService)
      .useValue(prisma)
      .compile();

    expect(moduleRef.get(OperatorPreferencesController)).toBeInstanceOf(
      OperatorPreferencesController,
    );
    expect(moduleRef.get(OperatorPreferencesService)).toBeInstanceOf(
      OperatorPreferencesService,
    );
    expect(moduleRef.get(PrismaService)).toBe(prisma);
  });
});
