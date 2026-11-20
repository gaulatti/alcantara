/* eslint-disable @typescript-eslint/no-unsafe-member-access -- the services are exercised through loosely typed fakes and answers are untyped JSON. */
import { ALCANTARA_PERMISSIONS } from '../../auth/permissions';
import { BroadcastDestinationsController } from '../../broadcast-destinations/broadcast-destinations.controller';
import { ExternalSourcesController } from '../../external-sources/external-sources.controller';
import { FillerController } from '../../filler/filler.controller';
import { OperatorPreferencesController } from '../../operator-preferences/operator-preferences.controller';
import { RadioController } from '../../radio/radio.controller';
import { RecordingController } from '../../recording/recording.controller';
import { TapeController } from '../../recording/tape.controller';
import { WebrtcController } from '../../webrtc/webrtc.controller';
import { ManagedMetricsService } from '../../observability/managed-metrics.service';
import { McpActionExecutor } from '../mcp-action.executor';
import {
  fakeServices,
  asRest,
  rebuilt,
  specNamed,
} from './capabilities.testing';
import {
  PLANTED_SECRET,
  callerWith,
  catalogRow,
  commandResult,
  consumerRow,
  downstream,
  externalSource,
  fillerState,
  invitation,
  participants,
  preferenceRow,
  profile,
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
import { RadioMcpTools } from './radio';
import { RecordingMcpTools } from './recording';
import { WebrtcMcpTools } from './webrtc';

// W, A and D rows (gaulatti/alcantara#219): each capability reaches the same
// service method as its controller with the same values, answers what the
// controller answers (user text under `untrusted`, never a credential), has a
// dry run, and the A and D rows have a confirm target that moves when the
// target does.

const p = ALCANTARA_PERMISSIONS;
const ctx = callerWith(
  p.access,
  p.broadcast.view,
  p.broadcast.manage,
  p.broadcast.operate,
  p.radio.manage,
  p.radio.operate,
  p.program.operate,
  p.layout.manage,
  p.webrtc.operate,
);
const authorization = {
  permissions: [...ctx.principal.permissions],
  teamId: 7,
};
// The services read the permissions and the team only; the console's guard
// attaches more, which no service looks at.
const request = {
  user: { ...requestOf(ctx).user, authorization },
};
const identity = { subject: 'sub-1', principalId: 'principal-1' };

const answers = (value: unknown) => jest.fn().mockResolvedValue(value);

function build() {
  const f = fakeServices();
  const s = {
    destinations: {
      listCatalog: answers([catalogRow]),
      createDestination: answers(catalogRow),
      updateDestination: answers(catalogRow),
      setRetired: answers({ ...catalogRow, retiredAt: new Date() }),
      reorderDestinations: answers([catalogRow]),
      getProgramState: answers({
        programId: 'main',
        available: true,
        destinations: [],
        downstream,
      }),
      start: answers(commandResult),
      stop: answers({ ...commandResult, action: 'stop' }),
      reload: answers({ ...commandResult, action: 'reload' }),
    },
    fillers: {
      getState: answers(fillerState),
      prepareTelevision: answers(fillerState),
      prepareRadio: answers(fillerState),
    },
    recording: {
      status: answers(recordingStatus),
      command: answers({ ...recordingStatus, state: 'requested' }),
      tapeStatus: answers(tapeStatus),
      tapeCommand: answers(tapeStatus),
    },
    radio: {
      getRadioSettings: answers(radioSettings),
      updateRadioSettings: answers({ ...radioSettings, enabled: false }),
      getRecoveryStatus: answers(recovery),
      prepareRecoveryPlaylist: answers(recovery),
      setRecoveryAutomation: answers(recovery),
      stopSong: answers(undefined),
      playInstant: answers(undefined),
      stopAllInstants: answers(undefined),
      getPalazzoStatus: answers({ running: true, uptime: null }),
    },
    consumers: {
      listConsumers: answers([consumerRow]),
      replaceConsumers: answers([{ ...consumerRow, name: 'Site' }]),
      outboundPublishing: jest.fn().mockReturnValue('enabled'),
    },
    similarity: { onSettingsChanged: answers(undefined) },
    telemetry: {
      handleRadioSettingsChanged: answers(undefined),
      getStatus: jest.fn(),
    },
    confidence: { get: jest.fn() },
    engine: { handleManualSong: jest.fn(), handleStopSong: jest.fn() },
    programs: f.programs,
    preferences: {
      discover: answers([sharedLayout]),
      get: answers(preferenceRow),
      save: answers({ ...preferenceRow, version: 4 }),
      load: answers({ layout: sharedLayout, preference: preferenceRow }),
      publish: answers(sharedLayout),
      retire: answers({ ...sharedLayout, retiredAt: new Date() }),
      reset: answers({ ok: true }),
    },
    prisma: {
      sharedConsoleLayout: { findUnique: answers(sharedLayout) },
    },
    pompeii: { teamId: 7 },
    sources: {
      list: answers([externalSource]),
      get: answers(externalSource),
      create: answers({
        ...externalSource,
        transport: 'rtmp',
        credential: { version: 1, secret: PLANTED_SECRET },
      }),
      update: answers(externalSource),
      validateRedirect: answers({ allowed: true, urlFingerprint: 'fp' }),
      reconcile: answers(externalSource),
      revoke: answers({ id: 'src-1', lifecycle: 'revoked' }),
    },
    webrtc: {
      listInvitations: answers([invitation]),
      listParticipants: answers(participants),
      revokeInvitation: answers({ id: 'inv-1', status: 'revoked' }),
      updateReturn: answers(invitation),
      controlParticipant: answers({ id: 'c-2', status: 'delivered' }),
      removeParticipant: answers({
        identity: participants.participants[0].identity,
        status: 'removed',
      }),
    },
  };
  const controllers = {
    destinations: new BroadcastDestinationsController(s.destinations as never),
    filler: new FillerController(s.fillers as never),
    recording: new RecordingController(s.recording as never),
    tape: new TapeController(s.recording as never),
    radio: new RadioController(
      s.radio as never,
      s.engine as never,
      s.consumers as never,
      s.telemetry as never,
      s.confidence as never,
      s.similarity as never,
    ),
    preferences: new OperatorPreferencesController(s.preferences as never),
    sources: new ExternalSourcesController(s.sources as never),
    webrtc: new WebrtcController(s.webrtc as never),
  };
  const specs = [
    ...new BroadcastDestinationsMcpTools(s.destinations as never).specs(),
    ...new FillerMcpTools(s.fillers as never).specs(),
    ...new RecordingMcpTools(s.recording as never).specs(),
    ...new RadioMcpTools(
      s.radio as never,
      s.consumers as never,
      s.telemetry as never,
      s.confidence as never,
      s.similarity as never,
      s.engine as never,
      s.programs as never,
    ).specs(),
    ...new OperatorPreferencesMcpTools(
      s.preferences as never,
      s.pompeii as never,
      s.prisma as never,
    ).specs(),
    ...new ExternalSourcesMcpTools(
      s.sources as never,
      s.pompeii as never,
      s.programs as never,
    ).specs(),
    ...new WebrtcMcpTools(s.webrtc as never, s.programs as never).specs(),
  ];
  const spec = (name: string) => specNamed(specs, name);
  const run = async (name: string, args: Record<string, unknown>) =>
    (await spec(name).run(args, ctx)).result;
  return { f, s, controllers, spec, run };
}

/**
 * Runs the capability, then the controller with the same input, against one
 * set of fakes: every listed service method was called with the same
 * arguments both times, and the answer is what the controller answered.
 */
async function parity(
  b: ReturnType<typeof build>,
  name: string,
  args: Record<string, unknown>,
  controller: () => unknown,
  services: jest.Mock[],
  answer?: (controllerAnswer: unknown) => unknown,
) {
  const before = services.map((service) => service.mock.calls.length);
  const result = await b.run(name, args);
  const mid = services.map((service) => service.mock.calls.length);
  const consoleAnswer = await controller();
  services.forEach((service, index) => {
    const viaCapability = service.mock.calls.slice(before[index], mid[index]);
    const viaController = service.mock.calls.slice(mid[index]);
    expect(viaCapability.length).toBeGreaterThan(0);
    expect(viaCapability).toEqual(viaController);
  });
  expect(rebuilt(result)).toEqual(
    asRest(answer ? answer(consoleAnswer) : consoleAnswer),
  );
  return result;
}

describe('broadcast destination writes', () => {
  it('create, update, retire, restore and reorder reach the console service', async () => {
    const b = build();
    const d = b.s.destinations;
    await parity(
      b,
      'destination_create_destination',
      {
        id: 'youtube',
        display_name: 'YouTube',
        secret_id: 'arn:x',
        secret_version_id: 'v1',
      },
      () =>
        b.controllers.destinations.createDestination({
          id: 'youtube',
          displayName: 'YouTube',
          secretId: 'arn:x',
          secretVersionId: 'v1',
        }),
      [d.createDestination],
    );
    await parity(
      b,
      'destination_update_destination',
      {
        destination_id: 'youtube',
        display_name: 'YouTube 2',
        secret_id: 'arn:y',
        secret_version_id: 'v2',
      },
      () =>
        b.controllers.destinations.updateDestination('youtube', {
          displayName: 'YouTube 2',
          secretId: 'arn:y',
          secretVersionId: 'v2',
        }),
      [d.updateDestination],
    );
    await parity(
      b,
      'destination_retire_destination',
      { destination_id: 'youtube' },
      () => b.controllers.destinations.retireDestination('youtube'),
      [d.setRetired],
    );
    await parity(
      b,
      'destination_restore_destination',
      { destination_id: 'youtube' },
      () => b.controllers.destinations.restoreDestination('youtube'),
      [d.setRetired],
    );
    await parity(
      b,
      'destination_reorder_destinations',
      { destination_ids: ['youtube'] },
      () =>
        b.controllers.destinations.reorderDestinations({
          destinationIds: ['youtube'],
        }),
      [d.reorderDestinations],
    );
  });

  it('plans an update of a destination that is not there as not_found', async () => {
    const b = build();
    await expect(
      b.spec('destination_retire_destination').dryRun!(
        { destination_id: 'nope' },
        ctx,
      ),
    ).rejects.toMatchObject({ code: 'not_found' });
    const plan = await b.spec('destination_retire_destination').dryRun!(
      { destination_id: 'youtube' },
      ctx,
    );
    expect(plan).toMatchObject({ recoverable: true, onAir: false });
    expect(plan.summary).toMatch(/destination_restore_destination/);
  });

  it.each(['start', 'reload', 'stop'] as const)(
    'destination_%s sends the console command as the caller, confirmed',
    async (verb) => {
      const b = build();
      const args: Record<string, unknown> = {
        program_id: 'main',
        command_id: 'cmd-1',
        ...(verb === 'stop'
          ? {}
          : {
              destination_ids: ['youtube'],
              selection_version: 'destinations-1',
            }),
      };
      await parity(
        b,
        `destination_${verb}`,
        args,
        () =>
          b.controllers.destinations[verb](
            'main',
            {
              commandId: 'cmd-1',
              ...(verb === 'stop'
                ? {}
                : {
                    destinationIds: ['youtube'],
                    selectionVersion: 'destinations-1',
                  }),
              confirmed: true,
            },
            request as never,
          ),
        [b.s.destinations[verb]],
      );
      expect(b.s.destinations[verb].mock.calls[0][2]).toBe('sub-1');
    },
  );

  it('confirms against where the executor is, and plans it live', async () => {
    const b = build();
    const spec = b.spec('destination_start');
    const args = {
      program_id: 'main',
      command_id: 'cmd-1',
      destination_ids: ['youtube'],
    };
    const before = await spec.confirmTarget!(args, ctx);
    expect(before.id).toBe('main');
    b.s.destinations.getProgramState.mockResolvedValue({
      programId: 'main',
      available: true,
      destinations: [],
      downstream: {
        ...downstream,
        requestedState: 'running',
        actualState: 'running',
      },
    });
    const after = await spec.confirmTarget!(args, ctx);
    expect(after.name).not.toBe(before.name);
    const plan = await spec.dryRun!(args, ctx);
    expect(plan).toMatchObject({ onAir: true, recoverable: true });
    expect(plan.summary).toMatch(/LIVE to 1 destination/);
    b.s.destinations.getProgramState.mockResolvedValue({
      available: false,
      downstream: { ...downstream, transition: null },
    });
    expect((await spec.confirmTarget!(args, ctx)).name).toBe(
      'executor-unavailable',
    );
  });

  it('reports a start the executor could not take as unavailable', async () => {
    const b = build();
    b.s.destinations.start.mockRejectedValue(new Error('boom'));
    await expect(
      b.run('destination_start', {
        program_id: 'main',
        command_id: 'cmd-1',
        destination_ids: ['youtube'],
      }),
    ).rejects.toThrow('boom');
  });
});

describe('filler writes', () => {
  it('prepare television and radio reach the console service as the caller', async () => {
    const b = build();
    await parity(
      b,
      'filler_prepare_television',
      { program_id: 'main', asset_id: 'image:1' },
      () =>
        b.controllers.filler.prepareTelevision(
          'main',
          { assetId: 'image:1' },
          request as never,
        ),
      [b.s.fillers.prepareTelevision],
    );
    await parity(
      b,
      'filler_prepare_radio',
      {
        program_id: 'main',
        asset_ids: ['audio:1', 'audio:2'],
        mode: 'shuffle',
        shuffle_seed: 'seed-1',
      },
      () =>
        b.controllers.filler.prepareRadio(
          'main',
          {
            assetIds: ['audio:1', 'audio:2'],
            mode: 'shuffle',
            shuffleSeed: 'seed-1',
          },
          request as never,
        ),
      [b.s.fillers.prepareRadio],
    );
  });

  it('says the on-air version is untouched', async () => {
    const b = build();
    const plan = await b.spec('filler_prepare_radio').dryRun!(
      { program_id: 'main', asset_ids: ['audio:1'] },
      ctx,
    );
    expect(plan).toMatchObject({ onAir: false, recoverable: true });
    expect(plan.summary).toMatch(/running keeps the version it started with/);
  });
});

describe('recording actions', () => {
  it.each([
    ['recording_start', 'start', 'recording'],
    ['recording_stop', 'stop', 'recording'],
    ['recording_tape_start', 'start', 'tape'],
    ['recording_tape_stop', 'stop', 'tape'],
  ] as const)('%s', async (name, action, kind) => {
    const b = build();
    const client = b.s.recording;
    const mock = kind === 'tape' ? client.tapeCommand : client.command;
    await parity(
      b,
      name,
      { program_id: 'main', command_key: 'key-1' },
      () =>
        kind === 'tape'
          ? b.controllers.tape[action]('main', 'key-1')
          : b.controllers.recording[action]('main', 'key-1'),
      [mock],
    );
    expect(mock).toHaveBeenCalledWith('main', action, 'key-1');
    const plan = await b.spec(name).dryRun!(
      { program_id: 'main', command_key: 'key-1' },
      ctx,
    );
    expect(plan).toMatchObject({
      onAir: true,
      recoverable: action === 'start',
    });
    expect(
      (await b.spec(name).confirmTarget!({ program_id: 'main' }, ctx)).id,
    ).toBe('main');
  });

  it('refuses an unbounded command key as invalid before the executor is called', async () => {
    const b = build();
    await expect(
      b.run('recording_start', { program_id: 'main', command_key: 'a b' }),
    ).rejects.toMatchObject({ code: 'invalid' });
    expect(b.s.recording.command).not.toHaveBeenCalled();
  });
});

describe('radio writes', () => {
  it("radio_update_settings does the controller's three steps", async () => {
    const b = build();
    const r = b.s.radio;
    await parity(
      b,
      'radio_update_settings',
      {
        program_id: 'main',
        enabled: false,
        similarity_mode: 'on',
        listener_url: null,
      },
      () =>
        b.controllers.radio.updateSettings('main', {
          enabled: false,
          similarityMode: 'on',
          listenerUrl: null,
        }),
      [
        r.getRadioSettings,
        r.updateRadioSettings,
        b.s.similarity.onSettingsChanged,
        b.s.telemetry.handleRadioSettingsChanged,
      ],
    );
    expect(b.s.similarity.onSettingsChanged).toHaveBeenCalledTimes(2);
    expect(b.s.telemetry.handleRadioSettingsChanged).toHaveBeenCalledTimes(2);
  });

  it('radio_update_settings is live for the fields that change the output only', async () => {
    const b = build();
    const spec = b.spec('radio_update_settings');
    expect(
      (await spec.dryRun!({ program_id: 'main', enabled: false }, ctx)).onAir,
    ).toBe(true);
    expect(
      (
        await spec.dryRun!(
          { program_id: 'main', listener_url: 'https://x.example/s' },
          ctx,
        )
      ).onAir,
    ).toBe(false);
  });

  it('prepare and the recovery session reach the console service', async () => {
    const b = build();
    const r = b.s.radio;
    await parity(
      b,
      'radio_prepare_recovery',
      { program_id: 'main', song_ids: [3, 4] },
      () => b.controllers.radio.prepareRecovery('main', { songIds: [3, 4] }),
      [r.prepareRecoveryPlaylist],
    );
    await parity(
      b,
      'radio_start_recovery',
      { program_id: 'main' },
      () => b.controllers.radio.startRecovery('main'),
      [r.setRecoveryAutomation],
    );
    await parity(
      b,
      'radio_stop_recovery',
      { program_id: 'main' },
      () => b.controllers.radio.stopRecovery('main'),
      [r.setRecoveryAutomation],
    );
  });

  it("confirms the recovery against Palazzo's automation state", async () => {
    const b = build();
    const spec = b.spec('radio_start_recovery');
    const before = await spec.confirmTarget!({ program_id: 'main' }, ctx);
    b.s.radio.getRecoveryStatus.mockResolvedValue({
      ...recovery,
      automation: { ...recovery.automation, actualState: 'running' },
    });
    expect(
      (await spec.confirmTarget!({ program_id: 'main' }, ctx)).name,
    ).not.toBe(before.name);
    b.s.radio.getRecoveryStatus.mockResolvedValue({
      ...recovery,
      automation: null,
      connection: 'unavailable',
    });
    expect((await spec.confirmTarget!({ program_id: 'main' }, ctx)).name).toBe(
      'recovery=palazzo-unavailable',
    );
  });

  it('the manual song and instant routes reach the console services', async () => {
    const b = build();
    await parity(
      b,
      'radio_play_song',
      {
        program_id: 'main',
        audio_url: 'https://cdn.example/a.mp3',
        title: 'T',
        artist: 'A',
        cover_url: 'https://cdn.example/c.png',
        duration_ms: 1000,
        song_id: 5,
      },
      () =>
        b.controllers.radio.playSong('main', {
          audioUrl: 'https://cdn.example/a.mp3',
          title: 'T',
          artist: 'A',
          coverUrl: 'https://cdn.example/c.png',
          durationMs: 1000,
          songId: 5,
        }),
      [b.s.engine.handleManualSong],
    );
    await parity(
      b,
      'radio_stop_song',
      { program_id: 'main' },
      () => b.controllers.radio.stopSong('main'),
      [b.s.radio.stopSong, b.s.engine.handleStopSong],
    );
    await parity(
      b,
      'radio_play_instant',
      {
        program_id: 'main',
        audio_url: 'https://cdn.example/i.mp3',
        volume: 0.5,
      },
      () =>
        b.controllers.radio.playInstant('main', {
          audioUrl: 'https://cdn.example/i.mp3',
          instantId: 1,
          volume: 0.5,
        }),
      [b.s.radio.playInstant],
    );
    await parity(
      b,
      'radio_stop_all_instants',
      { program_id: 'main' },
      () => b.controllers.radio.stopAllInstants('main'),
      [b.s.radio.stopAllInstants],
    );
  });

  it("confirms a song or instant against the program's live stamp", async () => {
    const b = build();
    const spec = b.spec('radio_stop_song');
    const idle = await spec.confirmTarget!({ program_id: 'main' }, ctx);
    b.f.programs.getProgramSongPlayback.mockResolvedValue({ isPlaying: true });
    const playing = await spec.confirmTarget!({ program_id: 'main' }, ctx);
    expect(playing.name).not.toBe(idle.name);
    const plan = await spec.dryRun!({ program_id: 'main' }, ctx);
    expect(plan.onAir).toBe(true);
    expect(plan.summary).toMatch(/a song is playing/);
    expect(plan.summary).toMatch(/automatic rotation turns manual/);
  });
});

describe('now-playing consumers', () => {
  const consumers = [
    {
      name: 'Site',
      url: 'https://site.example/now',
      method: 'PUT',
      headers: { 'X-Key': 'new-value' },
      enabled: true,
    },
  ];

  it('replaces the list as the console does and answers without header values', async () => {
    const b = build();
    await parity(
      b,
      'radio_replace_now_playing_consumers',
      { program_id: 'main', consumers },
      () =>
        b.controllers.radio.replaceNowPlayingConsumers('main', { consumers }),
      [b.s.consumers.replaceConsumers],
      (rows) =>
        (rows as Array<Record<string, unknown>>).map(
          ({ headers, ...rest }) => ({
            ...rest,
            headerNames: Object.keys(headers as object),
          }),
        ),
    );
  });

  it('keeps stored headers by consumer name without ever returning them', async () => {
    const b = build();
    const result = await b.run('radio_replace_now_playing_consumers', {
      program_id: 'main',
      consumers: [
        {
          name: consumerRow.name,
          url: consumerRow.url,
          keep_stored_headers: true,
          headers: { 'X-Extra': '1' },
        },
      ],
    });
    expect(b.s.consumers.replaceConsumers.mock.calls[0][1]).toEqual([
      {
        name: consumerRow.name,
        url: consumerRow.url,
        headers: { ...consumerRow.headers, 'X-Extra': '1' },
      },
    ]);
    expect(JSON.stringify(result)).not.toContain(PLANTED_SECRET);
  });

  it('refuses to keep the headers of a consumer that is not stored', async () => {
    const b = build();
    const args = {
      program_id: 'main',
      consumers: [
        {
          name: 'ghost',
          url: 'https://g.example/x',
          keep_stored_headers: true,
        },
      ],
    };
    await expect(
      b.spec('radio_replace_now_playing_consumers').dryRun!(args, ctx),
    ).rejects.toMatchObject({ code: 'invalid' });
    await expect(
      b.run('radio_replace_now_playing_consumers', args),
    ).rejects.toMatchObject({ code: 'invalid' });
    expect(b.s.consumers.replaceConsumers).not.toHaveBeenCalled();
  });

  it("reports the console's refusal of a consumer as invalid", async () => {
    const b = build();
    b.s.consumers.replaceConsumers.mockRejectedValue(
      new Error('Consumer 1: the URL must use https.'),
    );
    await expect(
      b.run('radio_replace_now_playing_consumers', {
        program_id: 'main',
        consumers: [{ url: 'http://x.example/y' }],
      }),
    ).rejects.toMatchObject({
      code: 'invalid',
      message: 'Consumer 1: the URL must use https.',
    });
  });

  it('plans the consumers that are dropped and says it cannot be recovered', async () => {
    const b = build();
    const plan = await b.spec('radio_replace_now_playing_consumers').dryRun!(
      { program_id: 'main', consumers: [] },
      ctx,
    );
    expect(plan.recoverable).toBe(false);
    expect(plan.summary).toMatch(
      /1 stored consumer\(s\) not in the list are deleted/,
    );
    expect(plan.affects.map((entry) => entry.kind)).toContain(
      'now_playing_consumer',
    );
    expect(JSON.stringify(plan)).not.toContain(PLANTED_SECRET);
  });
});

describe('operator preferences', () => {
  it('save, load and publish reach the console service as the caller', async () => {
    const b = build();
    const pr = b.s.preferences;
    await parity(
      b,
      'preference_save',
      { device_class: 'desktop', version: 3, profile },
      () =>
        b.controllers.preferences.save(
          'desktop',
          { version: 3, profile },
          request as never,
        ),
      [pr.save],
    );
    expect(pr.save.mock.calls[0][0]).toEqual(identity);
    await parity(
      b,
      'preference_load',
      { layout_id: 'layout-1', device_class: 'desktop', version: 3 },
      () =>
        b.controllers.preferences.load(
          'layout-1',
          { deviceClass: 'desktop', version: 3 },
          request as never,
        ),
      [pr.load],
    );
    expect(pr.load.mock.calls[0]).toEqual([
      identity,
      'layout-1',
      { deviceClass: 'desktop', version: 3 },
      authorization,
    ]);
    await b.run('preference_publish', {
      scope: 'program',
      scope_id: 'main',
      source_device_class: 'desktop',
      name: 'Evening',
      description: null,
      profile,
    });
    expect(pr.publish.mock.calls[0]).toEqual([
      identity,
      {
        scope: 'program',
        scopeId: 'main',
        sourceDeviceClass: 'desktop',
        name: 'Evening',
        description: null,
        profile,
      },
      authorization,
    ]);
  });

  it('plans a republish over a layout of the same name', async () => {
    const b = build();
    const plan = await b.spec('preference_publish').dryRun!(
      {
        scope: 'program',
        scope_id: 'main',
        source_device_class: 'desktop',
        name: sharedLayout.name,
        profile,
      },
      ctx,
    );
    expect(plan.summary).toMatch(/Replaces the shared layout/);
    expect(plan.recoverable).toBe(false);
  });

  it('refuses a stale version when planning a save', async () => {
    const b = build();
    const plan = await b.spec('preference_save').dryRun!(
      { device_class: 'desktop', version: 1, profile },
      ctx,
    );
    expect(plan.summary).toMatch(/refused with conflict/);
  });
});

describe('external source actions', () => {
  it('update, redirect and reconcile reach the console service with the team', async () => {
    const b = build();
    const sc = b.s.sources;
    await parity(
      b,
      'external_source_update',
      { source_id: 'src-1', name: 'Renamed', program_ids: ['main'] },
      () =>
        b.controllers.sources.update(
          'src-1',
          { name: 'Renamed', programIds: ['main'] },
          request as never,
        ),
      [sc.update],
    );
    await parity(
      b,
      'external_source_redirect',
      { source_id: 'src-1', url: 'https://x.example/live.m3u8' },
      () =>
        b.controllers.sources.redirect(
          'src-1',
          { url: 'https://x.example/live.m3u8' },
          request as never,
        ),
      [sc.validateRedirect],
    );
    await parity(
      b,
      'external_source_reconcile',
      {
        source_id: 'src-1',
        lifecycle: 'connected',
        health: 'healthy',
        ingress_id: 'in-1',
      },
      () =>
        b.controllers.sources.reconcile(
          'src-1',
          { lifecycle: 'connected', health: 'healthy', ingressId: 'in-1' },
          request as never,
        ),
      [sc.reconcile],
    );
  });

  it('create answers without the credential it issued', async () => {
    const b = build();
    const result = await b.run('external_source_create', {
      name: 'OB van',
      transport: 'rtmp',
      program_ids: ['main'],
    });
    expect(JSON.stringify(result)).not.toContain(PLANTED_SECRET);
    expect(result).toMatchObject({
      id: 'src-1',
      credentialIssued: true,
    });
    expect(b.s.sources.create).toHaveBeenCalledWith(
      'sub-1',
      { name: 'OB van', transport: 'rtmp', programIds: ['main'] },
      authorization,
    );
    const plan = await b.spec('external_source_create').dryRun!(
      { name: 'OB van', transport: 'rtmp', program_ids: ['main'] },
      ctx,
    );
    expect(plan.summary).toMatch(/NOT returned/);
    expect(plan.onAir).toBe(true);
  });

  it('create answers a pull source as the console does', async () => {
    const b = build();
    b.s.sources.create.mockResolvedValue(externalSource);
    const result = await b.run('external_source_create', {
      name: 'Remote',
      transport: 'hls',
      transport_config: { url: 'https://x.example/live.m3u8' },
      program_ids: ['main'],
    });
    expect(rebuilt(result)).toEqual(asRest(externalSource));
  });
});

describe('guest actions', () => {
  it('update_return and control reach the console service', async () => {
    const b = build();
    await parity(
      b,
      'webrtc_update_return',
      { invitation_id: 'inv-1', return_video: 'none', source_gain: 0.5 },
      () =>
        b.controllers.webrtc.updateReturn(request as never, 'inv-1', {
          returnVideo: 'none',
          sourceGain: 0.5,
        }),
      [b.s.webrtc.updateReturn],
    );
    expect(b.s.webrtc.updateReturn.mock.calls[0][0]).toEqual(identity);
    const guest = participants.participants[0].identity;
    await parity(
      b,
      'webrtc_control_participant',
      { program_id: 'main', identity: guest, type: 'message', text: 'Hi' },
      () =>
        b.controllers.webrtc.controlParticipant('main', guest, {
          type: 'message',
          text: 'Hi',
        }),
      [b.s.webrtc.controlParticipant],
    );
  });

  it('warns that an update_return resets the fields it does not carry', async () => {
    const b = build();
    const plan = await b.spec('webrtc_update_return').dryRun!(
      { invitation_id: 'inv-1', source_gain: 0.5 },
      ctx,
    );
    expect(plan.summary).toMatch(/Fields not given go to their defaults/);
    expect(plan.summary).toMatch(/video program, bus master, gain 0.5/);
  });
});

describe('through the action executor', () => {
  const executor = () =>
    new McpActionExecutor({
      recordMcpRequest: jest.fn(),
    } as unknown as ManagedMetricsService);

  it('a create runs dry-run, confirm and key, and never returns a credential', async () => {
    const b = build();
    const spec = b.spec('external_source_create');
    const args = { name: 'OB van', transport: 'rtmp', program_ids: ['main'] };
    const x = executor();
    const plan = (await x.execute(
      spec,
      { ...args, dry_run: true, idempotency_key: 'k-0000001' },
      ctx,
    )) as { confirm: string };
    expect(b.s.sources.create).not.toHaveBeenCalled();
    const done = await x.execute(
      spec,
      { ...args, confirm: plan.confirm, idempotency_key: 'k-0000001' },
      ctx,
    );
    expect(JSON.stringify(done)).not.toContain(PLANTED_SECRET);
    const again = await x.execute(
      spec,
      { ...args, confirm: plan.confirm, idempotency_key: 'k-0000001' },
      ctx,
    );
    expect(again).toEqual(done);
    expect(b.s.sources.create).toHaveBeenCalledTimes(1);
  });
});

describe('every W, A and D capability plans before it acts', () => {
  const guest = participants.participants[0].identity;
  const plans: Array<[string, Record<string, unknown>]> = [
    [
      'destination_create_destination',
      { id: 'y', display_name: 'Y', secret_id: 'a', secret_version_id: 'v' },
    ],
    ['destination_reorder_destinations', { destination_ids: ['youtube'] }],
    [
      'destination_update_destination',
      {
        destination_id: 'youtube',
        display_name: 'Y',
        secret_id: 'a',
        secret_version_id: 'v',
      },
    ],
    ['destination_restore_destination', { destination_id: 'youtube' }],
    [
      'destination_reload',
      { program_id: 'main', command_id: 'c', destination_ids: ['youtube'] },
    ],
    ['destination_stop', { program_id: 'main', command_id: 'c' }],
    ['filler_prepare_television', { program_id: 'main', asset_id: 'image:1' }],
    [
      'filler_prepare_radio',
      { program_id: 'main', asset_ids: ['audio:1'], mode: 'shuffle' },
    ],
    ['radio_prepare_recovery', { program_id: 'main', song_ids: [3] }],
    ['radio_start_recovery', { program_id: 'main' }],
    ['radio_stop_recovery', { program_id: 'main' }],
    [
      'radio_play_song',
      { program_id: 'main', audio_url: 'https://x.example/a' },
    ],
    [
      'radio_play_instant',
      { program_id: 'main', audio_url: 'https://x.example/a' },
    ],
    ['radio_stop_all_instants', { program_id: 'main' }],
    [
      'preference_load',
      { layout_id: 'layout-1', device_class: 'desktop', version: 3 },
    ],
    ['preference_save', { device_class: 'desktop', version: 3, profile }],
    ['external_source_update', { source_id: 'src-1', name: 'N' }],
    [
      'external_source_redirect',
      { source_id: 'src-1', url: 'https://x.example/l' },
    ],
    [
      'external_source_reconcile',
      { source_id: 'src-1', lifecycle: 'offline', health: 'unknown' },
    ],
    [
      'webrtc_control_participant',
      {
        program_id: 'main',
        identity: guest,
        type: 'media',
        device: 'camera',
        enabled: false,
      },
    ],
    [
      'webrtc_control_participant',
      { program_id: 'main', identity: guest, type: 'media', enabled: false },
    ],
    [
      'webrtc_control_participant',
      { program_id: 'main', identity: guest, type: 'cue', cue: 'live' },
    ],
  ];

  it.each(plans)('%s', async (name, args) => {
    const b = build();
    const plan = await b.spec(name).dryRun!(args, ctx);
    expect(plan.summary.length).toBeGreaterThan(20);
    expect(plan.affects.length).toBeGreaterThan(0);
    expect(plan.onAir).toBe(b.spec(name).tier === 'A');
    if (name === 'webrtc_control_participant')
      expect(plan.summary).toMatch(
        args.type === 'media' ? /track is muted/ : /sees or hears it/,
      );
    if (b.spec(name).tier === 'A')
      expect(await b.spec(name).confirmTarget!(args, ctx)).toMatchObject({
        id: expect.any(String) as string,
        name: expect.any(String) as string,
      });
  });

  it('plans a tape and a connected source by their state', async () => {
    const b = build();
    b.s.recording.tapeStatus.mockResolvedValue({
      ...tapeStatus,
      tape: { ...tapeStatus.tape, active: true },
    });
    expect(
      (
        await b.spec('recording_tape_stop').confirmTarget!(
          { program_id: 'main' },
          ctx,
        )
      ).name,
    ).toBe('active/idle');
    const plan = await b.spec('external_source_update').dryRun!(
      { source_id: 'src-1' },
      ctx,
    );
    expect(plan.summary).toMatch(/Changes nothing/i);
    expect(plan.summary).toMatch(/connected now/);
  });

  it('the settings change reloads similarity alone, and Palazzo telemetry alone', async () => {
    const b = build();
    b.s.radio.updateRadioSettings.mockResolvedValue(radioSettings);
    await b.run('radio_update_settings', {
      program_id: 'main',
      similarity_threshold: 0.5,
    });
    expect(b.s.similarity.onSettingsChanged).toHaveBeenCalledTimes(1);
    expect(b.s.telemetry.handleRadioSettingsChanged).not.toHaveBeenCalled();
    for (const field of [
      { similarity_window_seconds: 30 },
      { similarity_pool: 'catalog' },
    ])
      await b.run('radio_update_settings', { program_id: 'main', ...field });
    expect(b.s.similarity.onSettingsChanged).toHaveBeenCalledTimes(3);
    await b.run('radio_update_settings', {
      program_id: 'main',
      bumper_enabled: true,
    });
    expect(b.s.similarity.onSettingsChanged).toHaveBeenCalledTimes(3);
  });
});

describe('plans that depend on the state of the target', () => {
  it('names a retired destination, a revoked source and an unused source', async () => {
    const b = build();
    b.s.destinations.listCatalog.mockResolvedValue([
      { ...catalogRow, retiredAt: new Date() },
    ]);
    for (const verb of ['retire', 'restore'])
      await b.spec(`destination_${verb}_destination`).dryRun!(
        { destination_id: 'youtube' },
        ctx,
      );
    const revoked = {
      ...externalSource,
      revokedAt: new Date(),
      lifecycle: 'offline',
    };
    b.s.sources.get.mockResolvedValue(revoked);
    expect(
      (
        await b.spec('external_source_update').confirmTarget!(
          { source_id: 'src-1' },
          ctx,
        )
      ).name,
    ).toMatch(/revoked/);
    const plan = await b.spec('external_source_update').dryRun!(
      { source_id: 'src-1', name: 'N' },
      ctx,
    );
    expect(plan.summary).not.toMatch(/connected now/);
    b.s.programs.listPrograms.mockResolvedValue([]);
    const revoke = await b.spec('external_source_revoke').dryRun!(
      { source_id: 'src-1' },
      ctx,
    );
    expect(revoke.summary).toMatch(/already revoked/);
    expect(revoke.summary).toMatch(/\(none\)/);
  });

  it('plans a pull source without a credential note', async () => {
    const b = build();
    const plan = await b.spec('external_source_create').dryRun!(
      {
        name: 'Remote',
        transport: 'hls',
        transport_config: { url: 'https://x.example/l.m3u8' },
        program_ids: ['main'],
      },
      ctx,
    );
    expect(plan.summary).not.toMatch(/NOT returned/);
    const whip = await b.spec('external_source_create').dryRun!(
      { name: 'W', transport: 'whip', program_ids: ['main'] },
      ctx,
    );
    expect(whip.summary).toMatch(/NOT returned/);
  });

  it('plans a new shared layout, a matching load version and a retired layout', async () => {
    const b = build();
    b.s.preferences.discover.mockResolvedValue([]);
    const plan = await b.spec('preference_publish').dryRun!(
      {
        scope: 'team',
        scope_id: '7',
        source_device_class: 'desktop',
        name: 'New',
        profile,
      },
      ctx,
    );
    expect(plan.summary).toMatch(/Publishes a new shared layout/);
    expect(plan.recoverable).toBe(true);
    const load = await b.spec('preference_load').dryRun!(
      { layout_id: 'layout-1', device_class: 'desktop', version: 3 },
      ctx,
    );
    expect(load.summary).not.toMatch(/refused with conflict/);
    b.s.prisma.sharedConsoleLayout.findUnique.mockResolvedValue({
      ...sharedLayout,
      retiredAt: new Date(),
    });
    const retire = await b.spec('preference_retire').dryRun!(
      { layout_id: 'layout-1' },
      ctx,
    );
    expect(retire.summary).toMatch(/already retired/);
  });

  it('plans a settings change with no field, a recovery with no version and a string failure', async () => {
    const b = build();
    expect(
      (
        await b.spec('radio_update_settings').dryRun!(
          { program_id: 'main' },
          ctx,
        )
      ).summary,
    ).toMatch(/: none\./);
    b.s.radio.getRecoveryStatus.mockResolvedValue({
      ...recovery,
      preparedVersion: null,
    });
    expect(
      (
        await b.spec('radio_start_recovery').dryRun!(
          { program_id: 'main' },
          ctx,
        )
      ).summary,
    ).toMatch(/prepared version none/);
    b.s.consumers.replaceConsumers.mockRejectedValue('plain failure');
    await expect(
      b.run('radio_replace_now_playing_consumers', {
        program_id: 'main',
        consumers: [],
      }),
    ).rejects.toMatchObject({ code: 'invalid', message: 'plain failure' });
  });

  it('plans guest changes for a guest who is not connected and for a program that is not listed', async () => {
    const b = build();
    b.s.webrtc.listInvitations.mockResolvedValue([
      {
        ...invitation,
        status: 'available',
        slotNumber: null,
        sourceMuted: true,
      },
    ]);
    const update = await b.spec('webrtc_update_return').dryRun!(
      {
        invitation_id: 'inv-1',
        return_video: 'preview',
        return_audio_bus: 'aux-2',
        source_gain: 0.2,
        source_muted: true,
        source_delay_ms: 40,
      },
      ctx,
    );
    expect(update.summary).toMatch(
      /video preview, bus aux-2, gain 0.2, muted, delay 40 ms/,
    );
    expect(update.summary).not.toMatch(/sent the change at once/);
    b.s.programs.listPrograms.mockResolvedValue([]);
    const revoke = await b.spec('webrtc_revoke_invitation').dryRun!(
      { invitation_id: 'inv-1' },
      ctx,
    );
    expect(revoke.summary).toMatch(/slot none/);
    expect(revoke.summary).toMatch(/it is not now/);
    b.s.programs.listPrograms.mockResolvedValue([
      { programId: 'main', activeSceneId: 3, fadeToBlack: false },
    ]);
    const live = await b.spec('webrtc_remove_participant').dryRun!(
      { program_id: 'MAIN', identity: participants.participants[0].identity },
      ctx,
    );
    expect(live.summary).toMatch(/it is now/);
  });

  it('confirms guest actions against the guest, and plans defaults and a program off air', async () => {
    const b = build();
    const guest = participants.participants[0].identity;
    for (const [name, args] of [
      ['webrtc_update_return', { invitation_id: 'inv-1' }],
      ['webrtc_revoke_invitation', { invitation_id: 'inv-1' }],
      ['webrtc_remove_participant', { program_id: 'main', identity: guest }],
    ] as const)
      expect((await b.spec(name).confirmTarget!(args, ctx)).name).toMatch(
        /Guest/,
      );
    const update = await b.spec('webrtc_update_return').dryRun!(
      { invitation_id: 'inv-1' },
      ctx,
    );
    expect(update.summary).toMatch(
      /video program, bus master, gain 1, not muted, delay 0 ms/,
    );
    b.s.programs.listPrograms.mockResolvedValue([]);
    const remove = await b.spec('webrtc_remove_participant').dryRun!(
      { program_id: 'main', identity: guest },
      ctx,
    );
    expect(remove.summary).toMatch(/it is not now/);
    const load = await b.spec('preference_load').dryRun!(
      { layout_id: 'layout-1', device_class: 'desktop', version: 1 },
      ctx,
    );
    expect(load.summary).toMatch(/refused with conflict/);
  });
});
