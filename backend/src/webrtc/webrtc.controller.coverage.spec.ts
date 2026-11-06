import { WebrtcController } from './webrtc.controller';

describe('WebrtcController delegation', () => {
  const request = { user: { sub: 'pool-subject', principalId: null } };
  const identity = { subject: 'pool-subject', principalId: null };
  const names = [
    'getPublicConfig',
    'listInvitations',
    'createInvitation',
    'replaceInvitation',
    'revokeInvitation',
    'updateReturn',
    'redeemInvitation',
    'heartbeat',
    'acknowledgeCommand',
    'listParticipants',
    'createOperatorToken',
    'controlParticipant',
    'removeParticipant',
    'createRendererToken',
    'getRendererState',
    'createRendererSourceToken',
  ] as const;
  const webrtc = Object.fromEntries(
    names.map((name) => [name, jest.fn().mockReturnValue(`${name}-result`)]),
  ) as Record<(typeof names)[number], jest.Mock>;
  const controller = new WebrtcController(webrtc as never);

  beforeEach(() => jest.clearAllMocks());

  it('returns the public config', () => {
    expect(controller.config()).toBe('getPublicConfig-result');
    expect(webrtc.getPublicConfig).toHaveBeenCalledWith();
  });

  it('lists invitations', () => {
    expect(controller.listInvitations()).toBe('listInvitations-result');
    expect(webrtc.listInvitations).toHaveBeenCalledWith();
  });

  it('replaces and revokes invitations with the canonical identity', () => {
    expect(controller.replaceInvitation(request, 'inv-1')).toBe(
      'replaceInvitation-result',
    );
    expect(webrtc.replaceInvitation).toHaveBeenCalledWith(identity, 'inv-1');
    expect(controller.revokeInvitation(request, 'inv-1')).toBe(
      'revokeInvitation-result',
    );
    expect(webrtc.revokeInvitation).toHaveBeenCalledWith(identity, 'inv-1');
  });

  it('updates the return feed', () => {
    const body = { returnVideo: 'none' };
    expect(controller.updateReturn(request, 'inv-1', body)).toBe(
      'updateReturn-result',
    );
    expect(webrtc.updateReturn).toHaveBeenCalledWith(identity, 'inv-1', body);
  });

  it('redeems an invitation from the request body', () => {
    expect(
      controller.join({ invitation: 'inv.secret', sessionToken: 'sess' }),
    ).toBe('redeemInvitation-result');
    expect(webrtc.redeemInvitation).toHaveBeenCalledWith('inv.secret', 'sess');
  });

  it('forwards heartbeat session token and telemetry', () => {
    const telemetry = { quality: 'good' };
    expect(controller.heartbeat({ sessionToken: 'sess', telemetry })).toBe(
      'heartbeat-result',
    );
    expect(webrtc.heartbeat).toHaveBeenCalledWith('sess', telemetry);
  });

  it('forwards command acknowledgements', () => {
    expect(
      controller.acknowledge('cmd-1', { sessionToken: 'sess', status: 'read' }),
    ).toBe('acknowledgeCommand-result');
    expect(webrtc.acknowledgeCommand).toHaveBeenCalledWith(
      'sess',
      'cmd-1',
      'read',
    );
  });

  it('lists participants of a room', () => {
    expect(controller.listParticipants('main')).toBe('listParticipants-result');
    expect(webrtc.listParticipants).toHaveBeenCalledWith('main');
  });

  it('issues operator tokens for the requested program', () => {
    expect(controller.operatorToken(request, { programId: 'main' })).toBe(
      'createOperatorToken-result',
    );
    expect(webrtc.createOperatorToken).toHaveBeenCalledWith(identity, 'main');
  });

  it('controls a participant', () => {
    const body = { type: 'cue', cue: 'live' };
    expect(controller.controlParticipant('main', 'guest-1', body)).toBe(
      'controlParticipant-result',
    );
    expect(webrtc.controlParticipant).toHaveBeenCalledWith(
      'main',
      'guest-1',
      body,
    );
  });

  it('forwards the renderer key header for each renderer endpoint', () => {
    expect(controller.rendererToken('key', { programId: 'main' })).toBe(
      'createRendererToken-result',
    );
    expect(webrtc.createRendererToken).toHaveBeenCalledWith('key', 'main');
    expect(controller.rendererState(undefined, { programId: 'main' })).toBe(
      'getRendererState-result',
    );
    expect(webrtc.getRendererState).toHaveBeenCalledWith(undefined, 'main');
    expect(controller.rendererSourceToken('key', { programId: 'main' })).toBe(
      'createRendererSourceToken-result',
    );
    expect(webrtc.createRendererSourceToken).toHaveBeenCalledWith(
      'key',
      'main',
    );
  });
});
