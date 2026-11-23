import { Module } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { AlanaClient } from './alana.client';
import { BroadcastDestinationsController } from './broadcast-destinations.controller';
import { BroadcastDestinationsService } from './broadcast-destinations.service';
import { BroadcastDestinationKeysService } from './broadcast-destination-keys.service';
import { BroadcastIngestService } from './broadcast-ingest.service';
import { DestinationSecretsService } from './destination-secrets.service';
import { FillerBindingService } from '../filler/filler-binding.service';
import { BroadcastDestinationsMcpTools } from '../mcp/capabilities/destinations';

@Module({
  controllers: [BroadcastDestinationsController],
  providers: [
    BroadcastDestinationsMcpTools,
    BroadcastDestinationsService,
    BroadcastIngestService,
    BroadcastDestinationKeysService,
    DestinationSecretsService,
    AlanaClient,
    FillerBindingService,
    PrismaService,
  ],
})
export class BroadcastDestinationsModule {}
