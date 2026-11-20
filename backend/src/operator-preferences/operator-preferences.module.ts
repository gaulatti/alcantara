import { Module } from '@nestjs/common';
import { OperatorPreferencesController } from './operator-preferences.controller';
import { OperatorPreferencesService } from './operator-preferences.service';
import { PrismaService } from '../prisma.service';
import { OperatorPreferencesMcpTools } from '../mcp/capabilities/preferences';

@Module({
  controllers: [OperatorPreferencesController],
  providers: [
    OperatorPreferencesMcpTools,
    OperatorPreferencesService,
    PrismaService,
  ],
})
export class OperatorPreferencesModule {}
