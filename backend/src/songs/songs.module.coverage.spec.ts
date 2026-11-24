import { Global, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ManagedMetricsService } from '../observability/managed-metrics.service';
import { ProgramService } from '../program/program.service';
import { PrismaService } from '../prisma.service';
import { SongsController } from './songs.controller';
import { SongsModule } from './songs.module';
import { SongsService } from './songs.service';

// The program module is global in the application; the capability provider of
// this module asks for its service.
@Global()
@Module({
  providers: [{ provide: ProgramService, useValue: {} }],
  exports: [ProgramService],
})
class ProgramStubModule {}

// The metrics service is global in the application; the operator change recorder counts its records there.
@Global()
@Module({
  providers: [{ provide: ManagedMetricsService, useValue: {} }],
  exports: [ManagedMetricsService],
})
class MetricsStubModule {}

describe('SongsModule', () => {
  it('wires the controller to the service and prisma', async () => {
    const prisma = {
      song: { findUnique: jest.fn().mockResolvedValue(null) },
    };
    const moduleRef = await Test.createTestingModule({
      imports: [ProgramStubModule, MetricsStubModule, SongsModule],
    })
      .overrideProvider(PrismaService)
      .useValue(prisma)
      .compile();

    expect(moduleRef.get(SongsService)).toBeInstanceOf(SongsService);
    await expect(moduleRef.get(SongsController).findOne('5')).rejects.toThrow(
      'Song not found',
    );
    expect(prisma.song.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 5 } }),
    );
    await moduleRef.close();
  });
});
