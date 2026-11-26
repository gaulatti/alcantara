import { Global, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PompeiiService } from '../auth/pompeii.service';
import { OperatorChangeRecorder } from '../operator-change/operator-change-recorder';
import { noRecorder } from '../operator-change/operator-change-recorder.testing';
import { PrismaService } from '../prisma.service';
import { ProgramModule } from '../program/program.module';
import { ProgramService } from '../program/program.service';
import { ScenesController } from './scenes.controller';
import { ScenesModule } from './scenes.module';
import { ScenesService } from './scenes.service';

const programService = { getProgramIdsByAssignedScene: jest.fn() };

@Global()
@Module({
  providers: [
    { provide: ProgramService, useValue: programService },
    { provide: PompeiiService, useValue: { teamId: 0 } },
  ],
  exports: [ProgramService, PompeiiService],
})
class FakeProgramModule {}

describe('ScenesModule', () => {
  it('wires the controller and service to prisma and the program module', async () => {
    const prisma = {
      scene: { findMany: jest.fn().mockResolvedValue([{ id: 1 }]) },
    };
    const moduleRef = await Test.createTestingModule({
      imports: [ScenesModule],
    })
      .overrideModule(ProgramModule)
      .useModule(FakeProgramModule)
      .overrideProvider(OperatorChangeRecorder)
      .useValue(noRecorder())
      .overrideProvider(PrismaService)
      .useValue(prisma)
      .compile();

    expect(moduleRef.get(ScenesService)).toBeInstanceOf(ScenesService);
    await expect(
      moduleRef
        .get(ScenesController)
        .findAll({ user: { authorization: { teamId: 0 } } }),
    ).resolves.toEqual([{ id: 1 }]);
    expect(prisma.scene.findMany).toHaveBeenCalledWith({
      include: { layout: true },
      orderBy: { createdAt: 'desc' },
    });
    await moduleRef.close();
  });
});
