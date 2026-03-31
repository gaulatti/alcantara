import { Module, Global } from '@nestjs/common';
import { ProgramController } from './program.controller';
import { ProgramService } from './program.service';
import { ProgramRealtimeService } from './program.realtime.service';
import { PrismaService } from '../prisma.service';

@Global()
@Module({
  controllers: [ProgramController],
  providers: [ProgramService, ProgramRealtimeService, PrismaService],
  exports: [ProgramService, ProgramRealtimeService],
})
export class ProgramModule {}
