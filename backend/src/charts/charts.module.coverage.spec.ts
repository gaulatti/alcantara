import { Test } from '@nestjs/testing';
import { ChartsController } from './charts.controller';
import { ChartsModule } from './charts.module';
import { ChartsService } from './charts.service';
import { PrismaService } from '../prisma.service';

describe('ChartsModule', () => {
  it('provides and exports the charts service with Prisma and without a metrics provider', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ChartsModule],
    })
      .overrideProvider(PrismaService)
      .useValue({})
      .compile();
    const service = moduleRef.get(ChartsService);
    expect(service).toBeInstanceOf(ChartsService);
    expect(moduleRef.get(ChartsController)).toBeInstanceOf(ChartsController);
    await moduleRef.close();
  });
});
