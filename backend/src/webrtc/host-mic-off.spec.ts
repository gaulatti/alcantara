import { ConfigService } from '@nestjs/config';
import { ManagedMetricsService } from '../observability/managed-metrics.service';
import { WebrtcService } from './webrtc.service';

// The host's microphone on air can be taken off by the server: each `onair:host` track an operator publishes is muted
// in LiveKit. Only operator tracks count, and "muted" is reported only after LiveKit confirms each mute.

const OPERATOR = 'operator-0123456789abcdef0123-uuid';
const OTHER = 'operator-fedcba9876543210fedc-uuid';

function serviceWith(
  participants: unknown[],
  mute: jest.Mock = jest.fn(async () => ({})),
) {
  const service = new WebrtcService(
    new ConfigService({
      LIVEKIT_WS_URL: 'wss://livekit.example',
      LIVEKIT_API_KEY: 'fictional-key',
      LIVEKIT_API_SECRET: 'fictional-api-secret-at-least-thirty-two-characters',
      WEBRTC_SESSION_SECRET: 'fictional-session-secret-at-least-thirty-two',
      RENDERER_KEY: 'fictional-renderer-key',
      ALCANTARA_RENDERER_KEY: 'fictional-renderer-key',
    }),
    {} as never,
    new ManagedMetricsService(),
  );
  const roomService = {
    listParticipants: jest.fn(async () => participants),
    mutePublishedTrack: mute,
  };
  Object.defineProperty(service, 'roomService', { value: roomService });
  return { service, roomService, mute };
}

const track = (name: string, sid: string, muted = false) => ({ name, sid, muted, source: 2 });

describe('taking the host microphone off air', () => {
  it('reports no host microphone when no operator publishes the Mic on air track', async () => {
    const { service, mute } = serviceWith([
      { identity: OPERATOR, tracks: [track('camera', 'TR_cam')] },
      { identity: 'guest-1', tracks: [track('onair:host', 'TR_guest')] },
    ]);
    await expect(service.muteHostMic('main')).resolves.toEqual({ status: 'no-host-mic', muted: 0 });
    expect(mute).not.toHaveBeenCalled();
  });

  it('mutes the operator Mic on air track on the server and reports it only then', async () => {
    const { service, mute } = serviceWith([{ identity: OPERATOR, tracks: [track('onair:host', 'TR_mic')] }]);
    await expect(service.muteHostMic('main')).resolves.toEqual({ status: 'muted', muted: 1 });
    expect(mute).toHaveBeenCalledWith('alcantara-main', OPERATOR, 'TR_mic', true);
  });

  it('mutes every operator Mic on air track in the program', async () => {
    const { service, mute } = serviceWith([
      { identity: OPERATOR, tracks: [track('onair:host', 'TR_a')] },
      { identity: OTHER, tracks: [track('onair:host', 'TR_b', true)] },
    ]);
    await expect(service.muteHostMic('main')).resolves.toEqual({ status: 'muted', muted: 2 });
    expect(mute).toHaveBeenCalledTimes(2);
  });

  it('does not report muted when LiveKit refuses the mute', async () => {
    const { service } = serviceWith(
      [{ identity: OPERATOR, tracks: [track('onair:host', 'TR_mic')] }],
      jest.fn(async () => {
        throw new Error('livekit down');
      }),
    );
    await expect(service.muteHostMic('main')).rejects.toThrow();
  });

  it('refuses a program id that is not valid, before reading the room', async () => {
    const { service, roomService } = serviceWith([]);
    await expect(service.muteHostMic('')).rejects.toThrow();
    expect(roomService.listParticipants).not.toHaveBeenCalled();
  });

  it('reports no host microphone when the program room does not exist yet', async () => {
    const { service, roomService } = serviceWith([]);
    roomService.listParticipants.mockRejectedValueOnce(new Error('room not found'));
    await expect(service.muteHostMic('main')).resolves.toEqual({ status: 'no-host-mic', muted: 0 });
  });

  it('fails, without reporting anything muted, when LiveKit cannot list the room', async () => {
    const { service, roomService, mute } = serviceWith([]);
    roomService.listParticipants.mockRejectedValueOnce(new Error('connection reset'));
    await expect(service.muteHostMic('main')).rejects.toThrow();
    expect(mute).not.toHaveBeenCalled();
  });
});

// The dead-air watchdog asks who can be on air through calls before it acts: it holds on any guest cued live or host
// microphone published, and on a LiveKit it cannot read.
describe('who is on air through calls, for the dead-air watchdog', () => {
  // Only the program's host-mic identity reaches air (#880): another operator's onair:host does not hold the watchdog.
  it('counts the host microphone tracks that reach air and the guests cued live', async () => {
    const { service } = serviceWith([
      { identity: 'operator-host-mic-main', tracks: [track('onair:host', 'TR_mic')] },
      { identity: OPERATOR, tracks: [track('onair:host', 'TR_old')] },
      { identity: 'guest-1', tracks: [track('onair:host', 'TR_guest')] },
    ]);
    Object.defineProperty(service, 'onAirList', {
      value: jest.fn(async () => ({ programId: 'main', guests: ['guest-a', 'guest-b'] })),
    });
    await expect(service.onAirPresence('main')).resolves.toEqual({ guestsLive: 2, hostMics: 1 });
  });

  it('throws when LiveKit cannot be read, so the watchdog holds', async () => {
    const { service, roomService } = serviceWith([]);
    roomService.listParticipants.mockRejectedValueOnce(new Error('livekit down'));
    Object.defineProperty(service, 'onAirList', {
      value: jest.fn(async () => ({ programId: 'main', guests: [] })),
    });
    await expect(service.onAirPresence('main')).rejects.toThrow();
  });

  it('reports nobody where calls are not configured', async () => {
    const service = new WebrtcService(new ConfigService({}), {} as never, new ManagedMetricsService());
    await expect(service.onAirPresence('main')).resolves.toEqual({ guestsLive: 0, hostMics: 0 });
  });
});
