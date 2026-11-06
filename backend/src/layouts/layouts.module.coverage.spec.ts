import { Test } from '@nestjs/testing';
import { PrismaService } from '../prisma.service';
import { LayoutsController } from './layouts.controller';
import { LayoutsModule } from './layouts.module';
import { LayoutsService } from './layouts.service';

describe('LayoutsModule', () => {
  it('wires the controller to the service and prisma', async () => {
    const prisma = { layout: { findMany: jest.fn().mockResolvedValue([1]) } };
    const moduleRef = await Test.createTestingModule({
      imports: [LayoutsModule],
    })
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
