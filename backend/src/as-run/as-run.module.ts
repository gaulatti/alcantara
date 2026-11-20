import { Module } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { AsRunMcpTools } from '../mcp/capabilities/as-run';
import { AsRunController } from './as-run.controller';
import { AsRunService } from './as-run.service';

@Module({
  controllers: [AsRunController],
  providers: [AsRunService, AsRunMcpTools, PrismaService],
  exports: [AsRunService],
})
export class AsRunModule {}
