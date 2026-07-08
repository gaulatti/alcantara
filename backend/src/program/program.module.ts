import { Module, Global } from '@nestjs/common';
import { ProgramController } from './program.controller';
import { ProgramService } from './program.service';
import { ProgramRealtimeService } from './program.realtime.service';
import { FlightService } from './flight.service';
import { PrismaService } from '../prisma.service';

@Global()
@Module({
  controllers: [ProgramController],
  providers: [
    ProgramService,
    ProgramRealtimeService,
    FlightService,
    PrismaService,
  ],
  exports: [ProgramService, ProgramRealtimeService, FlightService],
})
export class ProgramModule {}
