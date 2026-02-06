import { Module, Global } from '@nestjs/common';
import { ProgramController } from './program.controller';
import { ProgramService } from './program.service';
import { PrismaService } from '../prisma.service';

@Global()
@Module({
  controllers: [ProgramController],
  providers: [ProgramService, PrismaService],
  exports: [ProgramService],
})
export class ProgramModule {}
