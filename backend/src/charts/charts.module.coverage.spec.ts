import { Test } from '@nestjs/testing';
import { ChartsController } from './charts.controller';
import { ChartsModule } from './charts.module';
import { ChartsService } from './charts.service';

describe('ChartsModule', () => {
  it('provides and exports the charts service without a metrics provider', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ChartsModule],
    }).compile();
    const service = moduleRef.get(ChartsService);
    expect(service).toBeInstanceOf(ChartsService);
    expect(moduleRef.get(ChartsController)).toBeInstanceOf(ChartsController);
    await moduleRef.close();
  });
});
