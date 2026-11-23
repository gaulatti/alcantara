import { Module } from '@nestjs/common';
import { LayoutsController } from './layouts.controller';
import { LayoutsService } from './layouts.service';
import { PrismaService } from '../prisma.service';
import { LayoutsMcpTools } from '../mcp/capabilities/layouts';

@Module({
  controllers: [LayoutsController],
  providers: [LayoutsService, LayoutsMcpTools, PrismaService],
})
export class LayoutsModule {}
