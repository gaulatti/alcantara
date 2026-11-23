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

@Global()
@Module({
  controllers: [ProgramController],
  providers: [
    ProgramService,
    ProgramRealtimeService,
    FlightService,
    ProgramTemplateService,
    ProgramMcpTools,
    SongLeavesMcpTools,
    FlightMcpTools,
    PrismaService,
  ],
  exports: [ProgramService, ProgramRealtimeService, FlightService],
})
export class ProgramModule {}
