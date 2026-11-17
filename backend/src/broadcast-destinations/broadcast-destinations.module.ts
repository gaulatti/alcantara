import { Module } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { AlanaClient } from './alana.client';
import { BroadcastDestinationsController } from './broadcast-destinations.controller';
import { BroadcastDestinationsService } from './broadcast-destinations.service';
import { FillerBindingService } from '../filler/filler-binding.service';

@Module({
  controllers: [BroadcastDestinationsController],
  providers: [
    BroadcastDestinationsService,
    AlanaClient,
    FillerBindingService,
    PrismaService,
  ],
})
export class BroadcastDestinationsModule {}
