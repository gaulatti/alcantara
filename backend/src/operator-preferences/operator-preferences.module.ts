import { Module } from '@nestjs/common';
import { OperatorPreferencesController } from './operator-preferences.controller';
import { OperatorPreferencesService } from './operator-preferences.service';
import { PrismaService } from '../prisma.service';

@Module({
  controllers: [OperatorPreferencesController],
  providers: [OperatorPreferencesService, PrismaService],
})
export class OperatorPreferencesModule {}
