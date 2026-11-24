import { OperatorChangeModule } from '../operator-change/operator-change.module';
import { Module } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { MediaController } from './media.controller';
import { MediaService } from './media.service';
import { MediaMcpTools } from '../mcp/capabilities/media';

@Module({
  imports: [OperatorChangeModule],
  controllers: [MediaController],
  providers: [MediaService, MediaMcpTools, PrismaService],
  exports: [MediaService],
})
export class MediaModule {}
