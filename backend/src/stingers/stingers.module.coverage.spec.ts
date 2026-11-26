import { Global, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PompeiiService } from '../auth/pompeii.service';
import { ManagedMetricsService } from '../observability/managed-metrics.service';
import { ProgramService } from '../program/program.service';
import { PrismaService } from '../prisma.service';
import { StingersController } from './stingers.controller';
import { StingersModule } from './stingers.module';
import { StingersService } from './stingers.service';

// The program module is global in the application; the capability provider of
// this module asks for its service.
@Global()
@Module({
  providers: [
    { provide: ProgramService, useValue: {} },
    { provide: PompeiiService, useValue: { teamId: 0 } },
  ],
  exports: [ProgramService, PompeiiService],
})
class ProgramStubModule {}

// The metrics service is global in the application; the operator change recorder counts its records there.
@Global()
@Module({
  providers: [{ provide: ManagedMetricsService, useValue: {} }],
  exports: [ManagedMetricsService],
})
class MetricsStubModule {}

describe('StingersModule', () => {
  it('wires the controller to the exported service and prisma', async () => {
    const prisma = { stinger: { findMany: jest.fn().mockResolvedValue([7]) } };
    const moduleRef = await Test.createTestingModule({
      imports: [ProgramStubModule, MetricsStubModule, StingersModule],
    })
      .overrideProvider(PrismaService)
      .useValue(prisma)
      .compile();

    expect(moduleRef.get(StingersService)).toBeInstanceOf(StingersService);
    await expect(
      moduleRef
        .get(StingersController)
        .listStingers({ user: { authorization: { teamId: 0 } } }),
    ).resolves.toEqual([7]);
    expect(prisma.stinger.findMany).toHaveBeenCalledWith({
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
    });
    await moduleRef.close();
  });
});
