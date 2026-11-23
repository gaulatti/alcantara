/* eslint-disable @typescript-eslint/no-explicit-any */
// gaulatti/alcantara#177: a v2 template's first state carries the broadcast
// settings while the time override is on, in the broadcast_settings_update
// `settings` shape, so a page loaded mid-override starts with it.
import { ProgramService } from './program.service';
import { projectProgramTemplateState } from './program-template.service';

const v2Manifest = {
  kind: 'alcantara.program-template',
  contractVersion: 2,
  schemaVersion: 2,
  entrypointUrl: 'https://templates.example.test/t/index.js',
  capabilities: [],
  control: { signals: ['scene_change', 'broadcast_settings_update'] },
};
const v1Manifest = { ...v2Manifest, contractVersion: 1, schemaVersion: 1 };

function build(templateManifest: Record<string, unknown> = v2Manifest) {
  let row: Record<string, unknown> = { id: 1, timeOverrideEnabled: false };
  const prisma: any = {
    $executeRawUnsafe: jest.fn().mockResolvedValue(0),
    broadcastSettings: {
      upsert: jest.fn(({ update }: { update: Record<string, unknown> }) => {
        row = { ...row, ...update };
        return Promise.resolve(row);
      }),
    },
    programState: {
      findUnique: jest.fn().mockResolvedValue({
        id: 7,
        programId: 'main',
        type: 'tv',
        activeSceneId: null,
        stagedSceneId: null,
        fadeToBlack: false,
        activeScene: null,
        scenes: [],
        templateManifest,
        updatedAt: '2026-11-17T00:00:00.000Z',
      }),
    },
  };
  const service = new ProgramService(prisma, {} as any, {} as any);
  const events: any[] = [];
  service.addEventListener((event) => events.push(event.data));
  return { service, events };
}

/** Turns the override on through the real settings path and returns the event's settings. */
async function startOverride(service: ProgramService, events: any[]) {
  await service.updateBroadcastSettings({ enabled: true, startTime: '21:30' });
  const event = events.find((e) => e.type === 'broadcast_settings_update');
  expect(event.settings).toMatchObject({ timeOverrideEnabled: true, timeOverrideStartTime: '21:30' });
  return event.settings;
}

describe('template state broadcast settings', () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('carries the broadcast_settings_update settings in the first state while the override is on', async () => {
    const { service, events } = build();
    const settings = await startOverride(service, events);
    const state = (await service.getPublicState('main')) as Record<string, unknown>;
    expect(state.broadcastSettings).toEqual(settings);
    expect(Object.keys(state.broadcastSettings as object).sort()).toEqual(Object.keys(settings).sort());
  });

  it('leaves the field absent while the override is off', async () => {
    const { service } = build();
    const state = (await service.getPublicState('main')) as Record<string, unknown>;
    expect(state).not.toHaveProperty('broadcastSettings');
    expect(state).toMatchObject({ schemaVersion: 2, id: 7, programId: 'main' });
  });

  it('never gives the field to a v1 template', async () => {
    const { service, events } = build(v1Manifest);
    await startOverride(service, events);
    const state = (await service.getPublicState('main')) as Record<string, unknown>;
    expect(state).not.toHaveProperty('broadcastSettings');
    expect(state.schemaVersion).toBe(1);
  });

  it('projects the field only for v2 and only when supplied', () => {
    const value = { id: 1, programId: 'main', version: 3 };
    const settings = { timeOverrideEnabled: true, timeOverrideStartTime: '06:00' };
    expect(projectProgramTemplateState({ ...value, broadcastSettings: settings }, { contractVersion: 2 })).toMatchObject({ broadcastSettings: settings });
    expect(projectProgramTemplateState(value, { contractVersion: 2 })).not.toHaveProperty('broadcastSettings');
    expect(projectProgramTemplateState({ ...value, broadcastSettings: 'on' }, { contractVersion: 2 })).not.toHaveProperty('broadcastSettings');
    expect(projectProgramTemplateState({ ...value, broadcastSettings: settings }, { contractVersion: 1 })).not.toHaveProperty('broadcastSettings');
  });

  it('carries the override on the v2 stream snapshot and on later state-bearing signals until it ends', async () => {
    jest.useFakeTimers();
    const { service, events } = build();
    // Over the stream the settings travel as JSON, exactly as the event's do.
    const settings = JSON.parse(JSON.stringify(await startOverride(service, events)));
    const out: any[] = [];
    const sub = service.getEventStream('main').subscribe((m) => out.push(JSON.parse(m.data)));
    await jest.advanceTimersByTimeAsync(0);
    expect(out[0]).toMatchObject({ type: 'program_state_snapshot', state: { broadcastSettings: settings } });

    const sceneChange = { type: 'scene_change', programId: 'main', state: { id: 7, programId: 'main' } };
    service.broadcastUpdate('main', sceneChange);
    expect(out[1].state.broadcastSettings).toEqual(settings);

    // Ending the override takes it off later states.
    await service.updateBroadcastSettings({ enabled: false });
    expect(out[2]).toMatchObject({ type: 'broadcast_settings_update', settings: { timeOverrideEnabled: false } });
    service.broadcastUpdate('main', sceneChange);
    expect(out[3].state).not.toHaveProperty('broadcastSettings');

    // Starting one mid-stream puts it on the next state.
    await service.updateBroadcastSettings({ enabled: true, startTime: '05:15' });
    service.broadcastUpdate('main', sceneChange);
    expect(out[5].state.broadcastSettings).toMatchObject({ timeOverrideEnabled: true, timeOverrideStartTime: '05:15' });

    // Signals without a state are left as they are.
    service.broadcastUpdate('main', { type: 'scene_change', programId: 'main' });
    expect(out).toHaveLength(6);
    sub.unsubscribe();
  });

  it('starts a v2 stream without the field when no override is on', async () => {
    jest.useFakeTimers();
    const { service } = build();
    const out: any[] = [];
    const sub = service.getEventStream('main').subscribe((m) => out.push(JSON.parse(m.data)));
    await jest.advanceTimersByTimeAsync(0);
    expect(out[0].state).not.toHaveProperty('broadcastSettings');
    service.broadcastUpdate('main', { type: 'scene_change', programId: 'main', state: { id: 7, programId: 'main' } });
    expect(out[1].state).not.toHaveProperty('broadcastSettings');
    sub.unsubscribe();
  });

  it('does not deliver a snapshot to a stream closed while the settings load', async () => {
    jest.useFakeTimers();
    const { service } = build();
    let release!: (value: unknown) => void;
    jest.spyOn(service as any, 'currentBroadcastSettings').mockReturnValue(new Promise((resolve) => { release = resolve; }));
    const out: any[] = [];
    const sub = service.getEventStream('main').subscribe((m) => out.push(m));
    await jest.advanceTimersByTimeAsync(0);
    sub.unsubscribe();
    release({ timeOverrideEnabled: true });
    await jest.advanceTimersByTimeAsync(0);
    expect(out).toEqual([]);
  });
});
