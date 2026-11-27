import { Module } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { WebrtcController } from './webrtc.controller';
import { WebrtcService } from './webrtc.service';
import { ReturnRouterController } from './return-router.controller';
import { ReturnRouterService } from './return-router.service';
import { WebrtcMcpTools } from '../mcp/capabilities/webrtc';

@Module({
  controllers: [WebrtcController, ReturnRouterController],
  providers: [
    WebrtcMcpTools,
    WebrtcService,
    ReturnRouterService,
    PrismaService,
  ],
  // The dead-air watchdog asks who is on air through calls (radio/dead-air-watchdog.module.ts).
  exports: [WebrtcService],
})
export class WebrtcModule {}
