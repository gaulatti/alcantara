import { ALCANTARA_PERMISSIONS } from '../../auth/permissions';
import { BroadcastDestinationsController } from '../../broadcast-destinations/broadcast-destinations.controller';
import { ExternalSourcesController } from '../../external-sources/external-sources.controller';
import { FillerController } from '../../filler/filler.controller';
import { OperatorPreferencesController } from '../../operator-preferences/operator-preferences.controller';
import { RadioController } from '../../radio/radio.controller';
import { RecordingController } from '../../recording/recording.controller';
import { TapeController } from '../../recording/tape.controller';
import { ReturnRouterController } from '../../webrtc/return-router.controller';
import { WebrtcController } from '../../webrtc/webrtc.controller';
import { McpToolError } from '../contract';
import { asRest, rebuilt, specNamed } from './capabilities.testing';
import {
  PLANTED_SECRET,
  callerWith,
  catalogRow,
  confidence,
  consumerRow,
  downstream,
  externalSource,
  fillerState,
  invitation,
  palazzoStatus,
  participants,
  preferenceRow,
  radioSettings,
  recordingStatus,
  recovery,
  requestOf,
  sharedLayout,
  tapeStatus,
} from './broadcast.testing';
import { BroadcastDestinationsMcpTools } from './destinations';
import { ExternalSourcesMcpTools } from './external-sources';
import { FillerMcpTools } from './filler';
import { OperatorPreferencesMcpTools } from './preferences';
import { RadioMcpTools, withoutHeaderValues } from './radio';
import { RecordingMcpTools } from './recording';
import { WebrtcMcpTools } from './webrtc';

// One set of fake services behind both the real controller and the capability:
// what the console is told is what the capability returns, with the user text
// under `untrusted` and no credential.

const p = ALCANTARA_PERMISSIONS;
const ctx = callerWith(p.access, p.radio.read, p.webrtc.read);
const request = requestOf(ctx);

const s = {
  destinations: {
    listDestinations: jest.fn(),
    listCatalog: jest.fn(),
    getProgramState: jest.fn(),
  },
  fillers: { getState: jest.fn() },
  recording: { status: jest.fn(), tapeStatus: jest.fn() },
  radio: {
    getRadioSettings: jest.fn(),
    getRecoveryStatus: jest.fn(),
    getPalazzoStatus: jest.fn(),
  },
  consumers: { listConsumers: jest.fn(), outboundPublishing: jest.fn() },
  telemetry: { getStatus: jest.fn(), getStatusWithReason: jest.fn() },
  confidence: { get: jest.fn() },
  preferences: { discover: jest.fn(), get: jest.fn() },
  pompeii: { teamId: 7 },
  sources: { list: jest.fn(), get: jest.fn() },
  webrtc: { listInvitations: jest.fn(), listParticipants: jest.fn() },
  returns: { health: jest.fn() },
  programs: { listPrograms: jest.fn() },
};

const controllers = {
  destinations: new BroadcastDestinationsController(
    s.destinations as never,
    {} as never,
    undefined as never,
    undefined as never,
  ),
  filler: new FillerController(s.fillers as never),
  recording: new RecordingController(s.recording as never),
  tape: new TapeController(s.recording as never),
  radio: new RadioController(
    s.radio as never,
    {} as never,
    s.consumers as never,
    s.telemetry as never,
    s.confidence as never,
    {} as never,
  ),
  preferences: new OperatorPreferencesController(s.preferences as never),
  sources: new ExternalSourcesController(s.sources as never),
  webrtc: new WebrtcController(s.webrtc as never),
  returns: new ReturnRouterController(s.returns as never, s.webrtc as never),
};

const specs = [
  ...new BroadcastDestinationsMcpTools(
    s.destinations as never,
    { teamId: 0 } as never,
    {} as never,
  ).specs(),
  ...new FillerMcpTools(s.fillers as never).specs(),
  ...new RecordingMcpTools(s.recording as never).specs(),
  ...new RadioMcpTools(
    s.radio as never,
    s.consumers as never,
    s.telemetry as never,
    s.confidence as never,
    {} as never,
    {} as never,
    s.programs as never,
  ).specs(),
  ...new OperatorPreferencesMcpTools(
    s.preferences as never,
    s.pompeii as never,
    {} as never,
  ).specs(),
  ...new ExternalSourcesMcpTools(
    s.sources as never,
    s.pompeii as never,
    s.programs as never,
  ).specs(),
  ...new WebrtcMcpTools(
    s.webrtc as never,
    s.programs as never,
    s.returns as never,
  ).specs(),
];

const run = async (name: string, args: Record<string, unknown> = {}) =>
  (await specNamed(specs, name).run(args, ctx)).result;

beforeEach(() => {
  jest.clearAllMocks();
  s.destinations.listDestinations.mockResolvedValue([
    { id: 'youtube', displayName: catalogRow.displayName, position: 0 },
  ]);
  s.destinations.listCatalog.mockResolvedValue([catalogRow]);
  s.destinations.getProgramState.mockResolvedValue({
    programId: 'main',
    available: true,
    destinations: [],
    downstream,
  });
  s.fillers.getState.mockResolvedValue(fillerState);
  s.recording.status.mockResolvedValue(recordingStatus);
  s.recording.tapeStatus.mockResolvedValue(tapeStatus);
  s.radio.getRadioSettings.mockResolvedValue(radioSettings);
  s.radio.getRecoveryStatus.mockResolvedValue(recovery);
  s.radio.getPalazzoStatus.mockResolvedValue({ running: true, uptime: null });
  s.consumers.listConsumers.mockResolvedValue([consumerRow]);
  s.consumers.outboundPublishing.mockReturnValue('blocked-local');
  s.telemetry.getStatus.mockReturnValue(palazzoStatus);
  s.telemetry.getStatusWithReason.mockResolvedValue(palazzoStatus);
  s.confidence.get.mockReturnValue(confidence);
  s.preferences.discover.mockResolvedValue([sharedLayout]);
  s.preferences.get.mockResolvedValue(preferenceRow);
  s.sources.list.mockResolvedValue([externalSource]);
  s.sources.get.mockResolvedValue(externalSource);
  s.webrtc.listInvitations.mockResolvedValue([invitation]);
  s.webrtc.listParticipants.mockResolvedValue(participants);
});

describe('read capabilities return what the controller returns', () => {
  const same = async (
    capability: string,
    args: Record<string, unknown>,
    controller: () => unknown,
  ) => {
    const result = await run(capability, args);
    expect(rebuilt(result)).toEqual(asRest(await controller()));
    return result;
  };

  it('destination_list_destinations', async () => {
    const result = await same('destination_list_destinations', {}, () =>
      controllers.destinations.listDestinations({
        user: { sub: 'u', authorization: { teamId: 0 } },
      } as never),
    );
    expect(JSON.stringify(result)).toContain('"untrusted"');
  });

  it('destination_list_catalog', async () => {
    const result = await same('destination_list_catalog', {}, () =>
      controllers.destinations.listCatalog({
        user: { sub: 'u', authorization: { teamId: 0 } },
      }),
    );
    expect(JSON.stringify(result)).toContain('"untrusted"');
  });

  it('destination_get_program_state', () =>
    same('destination_get_program_state', { program_id: 'main' }, () =>
      controllers.destinations.getProgramState('main', {
        user: { sub: 'u', authorization: { teamId: 0 } },
      }),
    ));

  it('filler_get_state', () =>
    same('filler_get_state', { program_id: 'main' }, () =>
      controllers.filler.getState('main'),
    ));

  it('recording_status', async () => {
    await same('recording_status', { program_id: 'main' }, () =>
      controllers.recording.status('main'),
    );
    expect(s.recording.status).toHaveBeenCalledWith('main');
  });

  it('recording_tape_status', () =>
    same('recording_tape_status', { program_id: 'main' }, () =>
      controllers.tape.status('main'),
    ));

  it('radio_get_settings', async () => {
    const result = await same(
      'radio_get_settings',
      { program_id: 'main' },
      () => controllers.radio.getSettings('main'),
    );
    expect(JSON.stringify(result)).toContain('"untrusted"');
  });

  it('radio_get_palazzo_status', () =>
    same('radio_get_palazzo_status', { program_id: 'main' }, () =>
      controllers.radio.getPalazzoStatus('main'),
    ));

  it('radio_get_output_confidence', async () => {
    await same('radio_get_output_confidence', { program_id: 'main' }, () =>
      controllers.radio.getOutputConfidence('main'),
    );
    expect(s.radio.getRadioSettings).toHaveBeenCalledWith('main');
  });

  it('radio_get_recovery', () =>
    same('radio_get_recovery', { program_id: 'main' }, () =>
      controllers.radio.getRecovery('main'),
    ));

  it('radio_list_now_playing_consumers answers the console list without header values', async () => {
    const result = await run('radio_list_now_playing_consumers', {
      program_id: 'main',
    });
    const console = await controllers.radio.listNowPlayingConsumers('main');
    expect(rebuilt(result)).toEqual(asRest(withoutHeaderValues(console)));
    expect(rebuilt(result)).toEqual([
      expect.objectContaining({
        id: 1,
        url: consumerRow.url,
        headerNames: ['Authorization', 'X-Station'],
      }),
    ]);
    expect(
      (result as Array<{ untrusted: { headerNames: string[] } }>)[0].untrusted
        .headerNames,
    ).toEqual(['Authorization', 'X-Station']);
  });

  it('radio_now_playing_publishing', () =>
    same('radio_now_playing_publishing', { program_id: 'main' }, () =>
      controllers.radio.nowPlayingPublishing(),
    ));

  it('radio_get_status', () =>
    same('radio_get_status', { program_id: 'main' }, () =>
      controllers.radio.getStatus('main'),
    ));

  it("preference_discover (the caller authorization is the guard's)", async () => {
    await same(
      'preference_discover',
      { scope: 'program', scope_id: 'main' },
      () =>
        controllers.preferences.discover('program', 'main', request as never),
    );
    const [scope, scopeId, authorization] = s.preferences.discover.mock
      .calls[0] as unknown[];
    expect([scope, scopeId]).toEqual(['program', 'main']);
    expect(authorization).toEqual({
      permissions: [...ctx.principal.permissions],
      teamId: 7,
    });
  });

  it("preference_get reads the caller's own profile", async () => {
    await same('preference_get', { device_class: 'desktop' }, () =>
      controllers.preferences.get('desktop', request as never),
    );
    expect(s.preferences.get).toHaveBeenNthCalledWith(
      1,
      { subject: 'sub-1', principalId: 'principal-1' },
      'desktop',
    );
    expect(s.preferences.get.mock.calls[0]).toEqual(
      s.preferences.get.mock.calls[1],
    );
  });

  it('external_source_list and external_source_get', async () => {
    await same('external_source_list', {}, () =>
      controllers.sources.list(request as never),
    );
    await same('external_source_get', { source_id: 'src-1' }, () =>
      controllers.sources.get('src-1', request as never),
    );
    const authorization = {
      permissions: [...ctx.principal.permissions],
      teamId: 7,
    };
    expect(s.sources.get.mock.calls[0]).toEqual(['src-1', authorization]);
    expect(s.sources.list.mock.calls[0]).toEqual([authorization]);
  });

  it('webrtc_list_invitations', async () => {
    const result = await same('webrtc_list_invitations', {}, () =>
      controllers.webrtc.listInvitations(),
    );
    expect(JSON.stringify(result)).toContain('"untrusted"');
  });

  it('webrtc_health answers what the desk reads, for the program asked about', async () => {
    const health = {
      programId: 'main',
      returnRunner: 'down',
      contribution: 'unknown',
      livekit: 'ok',
      checkedAt: '2026-11-27T09:00:00.000Z',
    };
    s.returns.health.mockResolvedValue(health);
    const result = await same('webrtc_health', { program_id: 'main' }, () =>
      controllers.returns.health('main'),
    );
    expect(JSON.stringify(result)).toContain('"returnRunner":"down"');
    expect(JSON.stringify(result)).toContain('"contribution":"unknown"');
  });

  it('webrtc_list_participants', () =>
    same('webrtc_list_participants', { program_id: 'main' }, () =>
      controllers.webrtc.listParticipants('main'),
    ));

  it('webrtc_list_participants carries studio-sound state and who is waiting', async () => {
    // The desk's "Hears the studio" / "not reaching" line and its waiting-guest state, as the console reads them.
    const [connected] = participants.participants;
    s.webrtc.listParticipants.mockResolvedValue({
      roomName: 'program-main',
      participants: [
        {
          ...connected,
          invitationId: 'inv-2',
          identity: 'guest-00000000-0000-0000-0000-000000000002',
          name: 'Guest two',
          slotNumber: 2,
          connectionState: 'connected',
          returnReaching: 'stalled',
          cueState: 'rejoined',
          screening: false,
        },
        {
          ...connected,
          invitationId: 'inv-3',
          identity: 'guest-00000000-0000-0000-0000-000000000003',
          name: 'Guest three',
          slotNumber: 3,
          connectionState: 'offline',
          returnReaching: null,
          screening: true,
        },
      ],
    });
    const result = await same(
      'webrtc_list_participants',
      { program_id: 'main' },
      () => controllers.webrtc.listParticipants('main'),
    );
    const text = JSON.stringify(result);
    expect(text).toContain('"returnReaching":"stalled"');
    expect(text).toContain('"cueState":"rejoined"');
    expect(text).toContain('"screening":true');
    expect(text).toContain('"returnReaching":null');
  });
});

describe('no read capability returns a credential', () => {
  it('never returns the value of a now-playing header', async () => {
    const result = await run('radio_list_now_playing_consumers', {
      program_id: 'main',
    });
    expect(JSON.stringify(result)).not.toContain(PLANTED_SECRET);
  });

  it.each([['radio_list_now_playing_consumers', { program_id: 'main' }]])(
    '%s keeps a header-less consumer working',
    async (name, args) => {
      s.consumers.listConsumers.mockResolvedValue([
        { ...consumerRow, headers: null },
      ]);
      expect(rebuilt(await run(name, args))).toEqual([
        expect.objectContaining({ headerNames: [] }),
      ]);
    },
  );

  it.each([
    [
      'destination_list_catalog',
      () =>
        s.destinations.listCatalog.mockResolvedValue([
          { ...catalogRow, secret: PLANTED_SECRET },
        ]),
      {},
    ],
    [
      'external_source_get',
      () =>
        s.sources.get.mockResolvedValue({
          ...externalSource,
          credential: { version: 1, secret: PLANTED_SECRET },
        }),
      { source_id: 'src-1' },
    ],
    [
      'webrtc_list_invitations',
      () =>
        s.webrtc.listInvitations.mockResolvedValue([
          { ...invitation, invitation: PLANTED_SECRET, token: PLANTED_SECRET },
        ]),
      {},
    ],
    [
      'recording_status',
      () =>
        s.recording.status.mockResolvedValue({
          ...recordingStatus,
          downloadUrl: `https://files.example/r.mp4?token=${PLANTED_SECRET}`,
        }),
      { program_id: 'main' },
    ],
  ])('withholds an answer that carries one (%s)', async (name, plant, args) => {
    plant();
    const error = await run(name, args as Record<string, unknown>).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(McpToolError);
    expect((error as McpToolError).code).toBe('unavailable');
    expect((error as McpToolError).message).not.toContain(PLANTED_SECRET);
  });
});

describe('read refusals', () => {
  it('reports a missing program as not_found', async () => {
    s.radio.getRadioSettings.mockRejectedValue(new Error('Program not found'));
    await expect(
      run('radio_get_settings', { program_id: 'nope' }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('reports an invalid recording program id as invalid', async () => {
    await expect(
      run('recording_status', { program_id: 'a/b' }),
    ).rejects.toMatchObject({ code: 'invalid' });
  });
});
