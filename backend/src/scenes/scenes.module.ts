import { Module } from '@nestjs/common';
import { ScenesController } from './scenes.controller';
import { ScenesService } from './scenes.service';
import { PrismaService } from '../prisma.service';
import { OperatorChangeModule } from '../operator-change/operator-change.module';
import { ProgramModule } from '../program/program.module';
import { ScenesMcpTools } from '../mcp/capabilities/scenes';

@Module({
  imports: [ProgramModule, OperatorChangeModule],
  controllers: [ScenesController],
  providers: [ScenesService, ScenesMcpTools, PrismaService],
})
export class ScenesModule {}
