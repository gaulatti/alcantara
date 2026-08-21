import { Module } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { WebrtcController } from './webrtc.controller';
import { WebrtcService } from './webrtc.service';

@Module({
  controllers: [WebrtcController],
  providers: [WebrtcService, PrismaService],
})
export class WebrtcModule {}
