import { Test } from '@nestjs/testing';
import { PrismaService } from '../prisma.service';
import { StingersController } from './stingers.controller';
import { StingersModule } from './stingers.module';
import { StingersService } from './stingers.service';

describe('StingersModule', () => {
  it('wires the controller to the exported service and prisma', async () => {
    const prisma = { stinger: { findMany: jest.fn().mockResolvedValue([7]) } };
    const moduleRef = await Test.createTestingModule({
      imports: [StingersModule],
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
