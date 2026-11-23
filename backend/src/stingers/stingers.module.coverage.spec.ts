import { Global, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ProgramService } from '../program/program.service';
import { PrismaService } from '../prisma.service';
import { StingersController } from './stingers.controller';
import { StingersModule } from './stingers.module';
import { StingersService } from './stingers.service';

// The program module is global in the application; the capability provider of
// this module asks for its service.
@Global()
@Module({
  providers: [{ provide: ProgramService, useValue: {} }],
  exports: [ProgramService],
})
class ProgramStubModule {}

describe('StingersModule', () => {
  it('wires the controller to the exported service and prisma', async () => {
    const prisma = { stinger: { findMany: jest.fn().mockResolvedValue([7]) } };
    const moduleRef = await Test.createTestingModule({
      imports: [ProgramStubModule, StingersModule],
    })
      .overrideProvider(PrismaService)
      .useValue(prisma)
      .compile();

    expect(moduleRef.get(StingersService)).toBeInstanceOf(StingersService);
    await expect(
      moduleRef.get(StingersController).listStingers(),
    ).resolves.toEqual([7]);
    expect(prisma.stinger.findMany).toHaveBeenCalledWith({
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
    });
    await moduleRef.close();
  });
});
