import { Module } from '@nestjs/common';
import { LayoutsController } from './layouts.controller';
import { LayoutsService } from './layouts.service';
import { PrismaService } from '../prisma.service';

@Module({
  controllers: [LayoutsController],
  providers: [LayoutsService, PrismaService],
})
export class LayoutsModule {}
