import { Module } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { OperatorChangeRecorder } from './operator-change-recorder';

@Module({
  providers: [OperatorChangeRecorder, PrismaService],
  exports: [OperatorChangeRecorder],
})
export class OperatorChangeModule {}
