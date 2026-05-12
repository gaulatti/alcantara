import { Module } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { StingersController } from './stingers.controller';
import { StingersService } from './stingers.service';

@Module({
  controllers: [StingersController],
  providers: [StingersService, PrismaService],
  exports: [StingersService],
})
export class StingersModule {}
