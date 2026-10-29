import { PrismaService } from '../prisma.service';
import { WebrtcController } from './webrtc.controller';
import { WebrtcModule } from './webrtc.module';
import { WebrtcService } from './webrtc.service';

describe('WebrtcModule', () => {
  it('registers the controller and its providers', () => {
    expect(Reflect.getMetadata('controllers', WebrtcModule)).toEqual([
      WebrtcController,
    ]);
    expect(Reflect.getMetadata('providers', WebrtcModule)).toEqual([
      WebrtcService,
      PrismaService,
    ]);
  });
});
