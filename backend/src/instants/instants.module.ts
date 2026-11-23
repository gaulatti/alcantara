import { Module } from '@nestjs/common';
import { ProgramModule } from '../program/program.module';
import { InstantsController } from './instants.controller';
import { InstantsMcpTools } from '../mcp/capabilities/instants';

@Module({
  imports: [ProgramModule],
  controllers: [InstantsController],
  providers: [InstantsMcpTools],
})
export class InstantsModule {}
