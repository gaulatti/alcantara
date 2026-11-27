import { WebrtcMcpTools } from '../mcp/capabilities/webrtc';
import { PrismaService } from '../prisma.service';
import { WebrtcController } from './webrtc.controller';
import { WebrtcModule } from './webrtc.module';
import { WebrtcService } from './webrtc.service';
import { ReturnRouterController } from './return-router.controller';
import { ReturnRouterService } from './return-router.service';

describe('WebrtcModule', () => {
  it('registers the controller and its providers', () => {
    expect(Reflect.getMetadata('controllers', WebrtcModule)).toEqual([
      WebrtcController,
      ReturnRouterController,
    ]);
    expect(Reflect.getMetadata('providers', WebrtcModule)).toEqual([
      WebrtcMcpTools,
      WebrtcService,
      ReturnRouterService,
      PrismaService,
    ]);
  });
});
