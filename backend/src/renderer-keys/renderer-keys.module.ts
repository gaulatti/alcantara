import { Module } from '@nestjs/common';
import { OperatorChangeModule } from '../operator-change/operator-change.module';
import { PrismaService } from '../prisma.service';
import { RendererKeyController } from './renderer-key.controller';
import { RendererKeyService } from './renderer-key.service';

/** Per-program renderer keys (gaulatti/alcantara#884): storage, issue and rotation, and the check the calls use. */
@Module({
  imports: [OperatorChangeModule],
  controllers: [RendererKeyController],
  providers: [RendererKeyService, PrismaService],
  exports: [RendererKeyService],
})
export class RendererKeysModule {}
