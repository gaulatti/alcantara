import { Module } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { AlanaClient } from '../broadcast-destinations/alana.client';
import { FillerController } from './filler.controller';
import { FillerService } from './filler.service';
import { FillerMcpTools } from '../mcp/capabilities/filler';

/** Per-program television and radio filler configuration (gaulatti/alcantara#126). */
@Module({
  controllers: [FillerController],
  providers: [FillerMcpTools, FillerService, AlanaClient, PrismaService],
})
export class FillerModule {}
