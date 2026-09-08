import { WebrtcController } from './webrtc.controller';

describe('WebrtcController canonical audit boundary', () => {
  const request = {
    user: {
      principalId: 'principal-a',
      sub: 'pool-subject-a',
    },
  };
  const webrtc = {
    createInvitation: jest.fn(),
    removeParticipant: jest.fn(),
  };
  const controller = new WebrtcController(webrtc as never);

  beforeEach(() => jest.clearAllMocks());

  it('passes both identities to invitation audit writes', async () => {
    const body = { displayName: 'Fixture' };
    await controller.createInvitation(request, body);

    expect(webrtc.createInvitation).toHaveBeenCalledWith(
      { principalId: 'principal-a', subject: 'pool-subject-a' },
      body,
    );
  });

  it('passes both identities to participant-removal audit writes', async () => {
    await controller.removeParticipant(request, 'main', 'guest-fixture');

    expect(webrtc.removeParticipant).toHaveBeenCalledWith(
      { principalId: 'principal-a', subject: 'pool-subject-a' },
      'main',
      'guest-fixture',
    );
  });
});
