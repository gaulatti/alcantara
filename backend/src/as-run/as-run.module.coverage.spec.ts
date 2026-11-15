import { AsRunModule } from './as-run.module';
import { AsRunController } from './as-run.controller';
import { AsRunService } from './as-run.service';
import { PrismaService } from '../prisma.service';

describe('AsRunModule wiring', () => {
  it('declares the controllers, providers, and exports', () => {
    expect(Reflect.getMetadata('controllers', AsRunModule)).toEqual([
      AsRunController,
    ]);
    expect(Reflect.getMetadata('providers', AsRunModule)).toEqual([
      AsRunService,
      PrismaService,
    ]);
    expect(Reflect.getMetadata('exports', AsRunModule)).toEqual([AsRunService]);
  });
});
