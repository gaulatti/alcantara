import { Module } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { AlanaClient } from './alana.client';
import { BroadcastDestinationsController } from './broadcast-destinations.controller';
import { BroadcastDestinationsService } from './broadcast-destinations.service';

@Module({
  controllers: [BroadcastDestinationsController],
  providers: [BroadcastDestinationsService, AlanaClient, PrismaService],
})
export class BroadcastDestinationsModule {}
