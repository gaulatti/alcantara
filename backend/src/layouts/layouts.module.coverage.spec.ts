import { Global, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ProgramService } from '../program/program.service';
import { OperatorChangeRecorder } from '../operator-change/operator-change-recorder';
import { noRecorder } from '../operator-change/operator-change-recorder.testing';
import { PrismaService } from '../prisma.service';
import { LayoutsController } from './layouts.controller';
import { LayoutsModule } from './layouts.module';
import { LayoutsService } from './layouts.service';

// The program module is global in the application; the capability provider of
// this module asks for its service.
@Global()
@Module({
  providers: [{ provide: ProgramService, useValue: {} }],
  exports: [ProgramService],
})
class ProgramStubModule {}

describe('LayoutsModule', () => {
  it('wires the controller to the service and prisma', async () => {
    const prisma = { layout: { findMany: jest.fn().mockResolvedValue([1]) } };
    const moduleRef = await Test.createTestingModule({
      imports: [ProgramStubModule, LayoutsModule],
    })
      .overrideProvider(OperatorChangeRecorder)
      .useValue(noRecorder())
      .overrideProvider(PrismaService)
      .useValue(prisma)
      .compile();

    const controller = moduleRef.get(LayoutsController);
    expect(moduleRef.get(LayoutsService)).toBeInstanceOf(LayoutsService);
    await expect(controller.findAll()).resolves.toEqual([1]);
    expect(prisma.layout.findMany).toHaveBeenCalled();
    await moduleRef.close();
  });
});
