import { Module } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { StingersController } from './stingers.controller';
import { StingersService } from './stingers.service';
import { StingersMcpTools } from '../mcp/capabilities/stingers';

@Module({
  controllers: [StingersController],
  providers: [StingersService, StingersMcpTools, PrismaService],
  exports: [StingersService],
})
export class StingersModule {}
