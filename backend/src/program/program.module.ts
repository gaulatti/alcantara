import { Module, Global } from '@nestjs/common';
import { ProgramController } from './program.controller';
import { ProgramService } from './program.service';
import { ProgramRealtimeService } from './program.realtime.service';
import { FlightService } from './flight.service';
import { PrismaService } from '../prisma.service';
import { ProgramTemplateService } from './program-template.service';
import { FlightMcpTools } from '../mcp/capabilities/flight';
import { ProgramMcpTools } from '../mcp/capabilities/program';
import { SongLeavesMcpTools } from '../mcp/capabilities/song-leaves';
import { RecipeMcpTools } from '../mcp/capabilities/recipes';
import { RecipesController } from './recipes.controller';
import { RecipesService } from './recipes.service';
import { ARTIST_LABEL_LOOKUP, NO_ARTIST_LABELS } from './artist-label-lookup';

@Global()
@Module({
  controllers: [ProgramController, RecipesController],
  providers: [
    ProgramService,
    ProgramRealtimeService,
    FlightService,
    ProgramTemplateService,
    ProgramMcpTools,
    SongLeavesMcpTools,
    FlightMcpTools,
    RecipesService,
    RecipeMcpTools,
    // gaulatti/alcantara#424: artist labels answer null until #427 binds #423's service here.
    { provide: ARTIST_LABEL_LOOKUP, useValue: NO_ARTIST_LABELS },
    PrismaService,
  ],
  exports: [ProgramService, ProgramRealtimeService, FlightService],
})
export class ProgramModule {}
