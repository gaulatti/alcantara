import { Module } from '@nestjs/common';
import { ProgramModule } from '../program/program.module';
import { InstantsController } from './instants.controller';

@Module({
  imports: [ProgramModule],
  controllers: [InstantsController],
})
export class InstantsModule {}
