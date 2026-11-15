import { Module } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { AsRunController } from './as-run.controller';
import { AsRunService } from './as-run.service';

@Module({
  controllers: [AsRunController],
  providers: [AsRunService, PrismaService],
  exports: [AsRunService],
})
export class AsRunModule {}
