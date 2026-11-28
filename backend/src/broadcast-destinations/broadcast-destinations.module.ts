import { Module } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { AlanaClient } from './alana.client';
import { BroadcastDestinationsController } from './broadcast-destinations.controller';
import { BroadcastDestinationsService } from './broadcast-destinations.service';
import { BroadcastDestinationKeysService } from './broadcast-destination-keys.service';
import { BroadcastIngestService } from './broadcast-ingest.service';
import { DestinationSecretsService } from './destination-secrets.service';
import { DestinationTestService } from './destination-test.service';
import { FillerBindingService } from '../filler/filler-binding.service';
import { BroadcastDestinationsMcpTools } from '../mcp/capabilities/destinations';
import { ProgramTeamAccess } from '../tenancy/program-team-access';

@Module({
  controllers: [BroadcastDestinationsController],
  providers: [
    BroadcastDestinationsMcpTools,
    BroadcastDestinationsService,
    BroadcastIngestService,
    BroadcastDestinationKeysService,
    DestinationSecretsService,
    DestinationTestService,
    AlanaClient,
    FillerBindingService,
    PrismaService,
    ProgramTeamAccess,
  ],
})
export class BroadcastDestinationsModule {}
