import { WebrtcController } from '../../webrtc/webrtc.controller';
import { callerWith } from './broadcast.testing';
import { specNamed } from './capabilities.testing';
import { WebrtcMcpTools } from './webrtc';

// gaulatti/alcantara#876: the MCP action takes the host's microphone off air, with the same permission as the desk. A
// dry run says what would be muted; a run with no host microphone says so, and reports "muted" only as LiveKit returns it.

const hostTrack = { identity: 'operator-abc-uuid', sid: 'TR_mic', muted: false };

function fixtures(tracks: unknown[] = [hostTrack]) {
  const webrtc = {
    hostMicTracks: jest.fn(async () => tracks),
    muteHostMic: jest.fn(async () =>
      tracks.length === 0
        ? { status: 'no-host-mic' as const, muted: 0 }
        : { status: 'muted' as const, muted: tracks.length },
    ),
  };
  const spec = specNamed(
    new WebrtcMcpTools(webrtc as never, {} as never, {} as never).specs(),
    'webrtc_host_mic_off',
  );
  return { webrtc, spec };
}

const ctx = callerWith('alcantara:webrtc:operate' as never);

describe('webrtc_host_mic_off', () => {
  it('is a tier A operate action', () => {
    const { spec } = fixtures();
    expect(spec).toMatchObject({ tier: 'A', permission: 'alcantara:webrtc:operate', firstClass: false });
  });

  it('dry run says what would be muted, and that nothing is when no host microphone is published', async () => {
    const one = fixtures();
    await expect(one.spec.dryRun!({ program_id: 'main' } as never, ctx)).resolves.toMatchObject({
      summary: expect.stringContaining('Mutes 1 host microphone track(s) on air in program main'),
    });
    expect(one.webrtc.muteHostMic).not.toHaveBeenCalled();

    const none = fixtures([]);
    await expect(none.spec.dryRun!({ program_id: 'main' } as never, ctx)).resolves.toMatchObject({
      summary: 'No host microphone is published in program main, so nothing is muted.',
    });
  });

  it('run mutes through the service and returns LiveKit\'s answer', async () => {
    const { webrtc, spec } = fixtures();
    const outcome = await spec.run({ program_id: 'main' } as never, ctx);
    expect(webrtc.muteHostMic).toHaveBeenCalledWith('main');
    expect(JSON.stringify(outcome)).toContain('"status":"muted"');
  });

  it('run with no host microphone reports that, and mutes nothing', async () => {
    const { webrtc, spec } = fixtures([]);
    const outcome = await spec.run({ program_id: 'main' } as never, ctx);
    expect(JSON.stringify(outcome)).toContain('"status":"no-host-mic"');
    expect(webrtc.muteHostMic).toHaveBeenCalledWith('main');
  });
});

describe('the route that takes the host microphone off air', () => {
  it('calls the service for the program in the path', async () => {
    const service = { muteHostMic: jest.fn(async () => ({ status: 'muted', muted: 1 })) };
    const controller = new WebrtcController(service as never);
    await expect(controller.muteHostMic('main')).resolves.toEqual({ status: 'muted', muted: 1 });
    expect(service.muteHostMic).toHaveBeenCalledWith('main');
  });
});
