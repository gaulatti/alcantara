import { BadRequestException, ServiceUnavailableException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ManagedMetricsService } from '../observability/managed-metrics.service';
import { WebrtcController } from './webrtc.controller';
import { WebrtcService, hostMicIdentity } from './webrtc.service';

// One host microphone per program on air (gaulatti/alcantara#879): its token has one identity per program, so LiveKit
// admits one at a time and a second tab or device disconnects the first, whatever either page does.

const config = {
  LIVEKIT_WS_URL: 'wss://livekit.example.test',
  LIVEKIT_API_URL: 'http://api.example.test:7880',
  LIVEKIT_API_KEY: 'fictional-key',
  LIVEKIT_API_SECRET: 'fictional-api-secret-at-least-thirty-two-characters',
  WEBRTC_SESSION_SECRET: 'fictional-session-secret-at-least-thirty-two',
};
const service = (values: Record<string, string> = config) =>
  new WebrtcService(
    new ConfigService(values),
    {} as never,
    new ManagedMetricsService(),
  );
const claims = (token: string) =>
  JSON.parse(
    Buffer.from(token.split('.')[1], 'base64url').toString('utf8'),
  ) as {
    sub: string;
    name: string;
    metadata: string;
    video: Record<string, unknown>;
  };

describe('the host microphone token', () => {
  it('has the one identity of the program, so a second one replaces the first', async () => {
    const webrtc = service();
    const first = await webrtc.createHostMicToken(' modoitaliano.fm ');
    const second = await webrtc.createHostMicToken('modoitaliano.fm');
    expect(first.roomName).toBe('alcantara-modoitaliano.fm');
    expect(first.serverUrl).toBe('wss://livekit.example.test');
    expect(claims(first.token).sub).toBe('operator-host-mic-modoitaliano.fm');
    expect(claims(second.token).sub).toBe(claims(first.token).sub);
    expect(hostMicIdentity('main')).toBe('operator-host-mic-main');
    // Another show has its own.
    expect(claims((await webrtc.createHostMicToken('main')).token).sub).toBe(
      'operator-host-mic-main',
    );
  });

  it('publishes a microphone only, sees no one and sends no data', async () => {
    const { token } = await service().createHostMicToken('main');
    const { video, metadata, name } = claims(token);
    expect(video).toMatchObject({
      room: 'alcantara-main',
      roomJoin: true,
      canPublish: true,
      canPublishSources: ['microphone'],
      canSubscribe: false,
      canPublishData: false,
    });
    expect(JSON.parse(metadata)).toEqual({ role: 'host-mic' });
    expect(name).toBe('Alcantara host microphone');
  });

  it('records who was given one, with no token in the line', async () => {
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation();
    const { token } = await service().createHostMicToken('main', 'prn_one');
    await service().createHostMicToken('main');
    expect(log.mock.calls.map(([line]) => line as string)).toEqual([
      'Host microphone token issued for main to principal prn_one',
      'Host microphone token issued for main to principal unknown',
    ]);
    expect(String(log.mock.calls)).not.toContain(token);
    log.mockRestore();
  });

  it('refuses a bad program id, and answers 503 without LiveKit', async () => {
    await expect(
      service().createHostMicToken('news/main'),
    ).rejects.toBeInstanceOf(BadRequestException);
    const { LIVEKIT_API_KEY: _key, ...unconfigured } = config;
    void _key;
    await expect(
      service(unconfigured).createHostMicToken('main'),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('is served on POST /webrtc/host-mic-token with the program from the body', async () => {
    const createHostMicToken = jest.fn().mockResolvedValue({ token: 't' });
    const controller = new WebrtcController({ createHostMicToken } as never);
    await expect(
      controller.hostMicToken(
        { user: { sub: 'fictional-sub', principalId: 'prn_fictional' } },
        { programId: 'main' },
      ),
    ).resolves.toEqual({
      token: 't',
    });
    expect(createHostMicToken).toHaveBeenCalledWith('main', 'prn_fictional');
  });
});
