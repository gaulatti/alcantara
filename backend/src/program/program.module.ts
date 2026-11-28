import { Module, Global } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { ProgramTeamAccess } from '../tenancy/program-team-access';
import { ProgramTeamInterceptor } from '../tenancy/program-team.interceptor';
import { ProgramController } from './program.controller';
import { ProgramService } from './program.service';
import { SceneAssetScope } from './scene-asset-scope';
import { ProgramRealtimeService } from './program.realtime.service';
import { FlightService } from './flight.service';
import { OperatorChangeModule } from '../operator-change/operator-change.module';
import { PrismaService } from '../prisma.service';
import { ProgramTemplateService } from './program-template.service';
import { FlightMcpTools } from '../mcp/capabilities/flight';
import { ProgramMcpTools } from '../mcp/capabilities/program';
import { SongLeavesMcpTools } from '../mcp/capabilities/song-leaves';
import { RecipeMcpTools } from '../mcp/capabilities/recipes';
import { RecipesController } from './recipes.controller';
import { RecipesService } from './recipes.service';
import { RadioClocksController } from './radio-clocks.controller';
import { RadioClocksService } from './radio-clocks.service';
import {
  ARTIST_LABEL_LOOKUP,
  type ArtistLabelLookup,
} from './artist-label-lookup';
import { ArtistLabelsModule } from '../artist-labels/artist-labels.module';
import { ArtistLabelsService } from '../artist-labels/artist-labels.service';

@Global()
@Module({
  imports: [ArtistLabelsModule, OperatorChangeModule],
  controllers: [ProgramController, RecipesController, RadioClocksController],
  providers: [
    ProgramService,
    SceneAssetScope,
    ProgramRealtimeService,
    FlightService,
    ProgramTemplateService,
    ProgramMcpTools,
    SongLeavesMcpTools,
    FlightMcpTools,
    RecipesService,
    RecipeMcpTools,
    RadioClocksService,
    // Here, so it shares this module's database client.
    ProgramTeamAccess,
    { provide: APP_INTERCEPTOR, useClass: ProgramTeamInterceptor },
    // gaulatti/alcantara#427: the song recipe finds the artist's label through #423's service. A song
    // with no team is the deployment's own, which that service scopes as team 0.
    {
      provide: ARTIST_LABEL_LOOKUP,
      useFactory: (labels: ArtistLabelsService): ArtistLabelLookup => ({
        artistLabelFor: (teamId, artist) =>
          labels.artistLabelFor(teamId ?? 0, artist),
      }),
      inject: [ArtistLabelsService],
    },
    PrismaService,
  ],
  exports: [
    ProgramService,
    ProgramRealtimeService,
    FlightService,
    ProgramTeamAccess,
  ],
})
export class ProgramModule {}
