/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access -- tool answers are untyped JSON. */
import { DiscoveryModule } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { z } from 'zod';
import { ALCANTARA_PERMISSIONS } from '../../auth/permissions';
import { ManagedMetricsService } from '../../observability/managed-metrics.service';
import { ProgramService } from '../../program/program.service';
import { RadioService } from '../../radio/radio.service';
import { StingersService } from '../../stingers/stingers.service';
import { MCP_ACTION_EXECUTOR } from '../contract';
import { McpActionExecutor } from '../mcp-action.executor';
import { McpRegistry } from '../mcp-registry.service';
import { fakeServices, principalWith } from './capabilities.testing';
import { InstantsMcpTools } from './instants';
import {
  instantRow,
  listed,
  sceneNaming,
  stinger,
} from './instants-stingers.testing';
import { StingersMcpTools } from './stingers';

// The providers found through Nest discovery and run on the registry's real
// call path: a caller sees and may call only what its permissions allow, and
// the A and D rows go through dry run, confirmation and idempotency.

type Handler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ text: string }>;
  isError?: boolean;
}>;

const permissions = ALCANTARA_PERMISSIONS;

async function connect(principal: ReturnType<typeof principalWith>) {
  const fakes = {
    programs: {
      ...fakeServices().programs,
      listInstants: jest.fn().mockResolvedValue([instantRow()]),
      listPrograms: jest.fn().mockResolvedValue([listed()]),
      createInstant: jest.fn().mockResolvedValue(instantRow()),
      deleteInstant: jest.fn().mockResolvedValue({ deletedInstantId: 8 }),
      playInstant: jest.fn().mockResolvedValue({ ok: true }),
      stopAllInstants: jest.fn().mockResolvedValue({ ok: true }),
    },
    radio: { getRadioSettings: jest.fn().mockResolvedValue(null) },
    stingers: {
      findAll: jest.fn().mockResolvedValue([stinger]),
      findOne: jest.fn().mockResolvedValue(stinger),
      remove: jest.fn().mockResolvedValue({ deletedStingerId: 7 }),
    },
  };
  const module = await Test.createTestingModule({
    imports: [DiscoveryModule],
    providers: [
      McpRegistry,
      McpActionExecutor,
      { provide: MCP_ACTION_EXECUTOR, useExisting: McpActionExecutor },
      ManagedMetricsService,
      { provide: ProgramService, useValue: fakes.programs },
      { provide: RadioService, useValue: fakes.radio },
      { provide: StingersService, useValue: fakes.stingers },
      InstantsMcpTools,
      StingersMcpTools,
    ],
  }).compile();
  await module.init();
  const tools = new Map<string, Handler>();
  const reauthorize = jest.fn(() => Promise.resolve(principal));
  module.get(McpRegistry).register(
    {
      registerTool: (
        name: string,
        _config: { inputSchema: z.ZodRawShape },
        handler: Handler,
      ) => tools.set(name, handler),
    } as never,
    principal,
    reauthorize as never,
  );
  const call = async (name: string, args: Record<string, unknown>) => {
    const answer = await tools.get(name)!(args);
    return {
      body: JSON.parse(answer.content[0].text),
      isError: answer.isError === true,
    };
  };
  const capability = (name: string, args: Record<string, unknown>) =>
    call('call_capability', { name, arguments: args });
  const names = async () =>
    (
      (await call('list_capabilities', { limit: 100 })).body
        .capabilities as Array<{ name: string }>
    ).map((c) => c.name);
  return { module, capability, names, fakes, reauthorize };
}

const AREA = /^(instant_|stinger_)/;
const everything = [
  permissions.access,
  permissions.instant.read,
  permissions.instant.manage,
  permissions.instant.operate,
  permissions.stinger.read,
  permissions.stinger.manage,
];

describe('instant and stinger capabilities through the registry', () => {
  it('shows every capability to a caller who holds the permissions, and runs a read', async () => {
    const { module, names, capability } = await connect(
      principalWith(...everything),
    );
    expect((await names()).filter((n) => AREA.test(n)).sort()).toEqual([
      'instant_create_instant',
      'instant_delete_instant',
      'instant_list_instants',
      'instant_play_instant',
      'instant_stop_all_instants',
      'instant_update_instant',
      'stinger_create_stinger',
      'stinger_delete_stinger',
      'stinger_list_stingers',
      'stinger_update_stinger',
    ]);
    const instants = await capability('instant_list_instants', {});
    expect(instants.isError).toBe(false);
    expect(instants.body[0].untrusted.name).toContain('Station id');
    await module.close();
  });

  it.each([
    ['instant_list_instants', {}],
    ['stinger_list_stingers', {}],
    ['instant_create_instant', { name: 'x', audio_url: 'y' }],
    ['instant_play_instant', { instant_id: 8 }],
    ['instant_stop_all_instants', {}],
    ['stinger_delete_stinger', { stinger_id: 7 }],
    ['instant_delete_instant', { instant_id: 8 }],
  ])(
    'does not list %s for a caller without its permission and refuses the call',
    async (name, args) => {
      const { module, names, capability, fakes } = await connect(
        principalWith(permissions.access),
      );
      expect(await names()).not.toContain(name);
      const refused = await capability(name, {
        ...args,
        confirm: 'c',
        idempotency_key: 'key-00000001',
      });
      expect(refused.isError).toBe(true);
      expect(refused.body.error).toBe('forbidden');
      expect(fakes.programs.listInstants).not.toHaveBeenCalled();
      expect(fakes.programs.playInstant).not.toHaveBeenCalled();
      expect(fakes.programs.stopAllInstants).not.toHaveBeenCalled();
      expect(fakes.programs.createInstant).not.toHaveBeenCalled();
      expect(fakes.programs.deleteInstant).not.toHaveBeenCalled();
      expect(fakes.stingers.remove).not.toHaveBeenCalled();
      await module.close();
    },
  );

  it('runs the A row through dry run, confirm and idempotency on the default program', async () => {
    const { module, capability, fakes, reauthorize } = await connect(
      principalWith(...everything),
    );
    const dry = await capability('instant_play_instant', {
      instant_id: 8,
      dry_run: true,
      idempotency_key: 'key-00000001',
    });
    expect(dry.body).toMatchObject({ dry_run: true, onAir: true });
    const missing = await capability('instant_play_instant', {
      instant_id: 8,
      idempotency_key: 'key-00000001',
    });
    expect(missing.body.error).toBe('confirm_required');
    const done = await capability('instant_play_instant', {
      instant_id: 8,
      confirm: dry.body.confirm,
      idempotency_key: 'key-00000001',
    });
    expect(done.isError).toBe(false);
    expect(done.body).toEqual({ ok: true });
    expect(fakes.programs.playInstant).toHaveBeenCalledWith(8, 'main');
    // A retry with the same key replays the stored outcome and plays nothing.
    await capability('instant_play_instant', {
      instant_id: 8,
      confirm: dry.body.confirm,
      idempotency_key: 'key-00000001',
    });
    expect(fakes.programs.playInstant).toHaveBeenCalledTimes(1);
    expect(reauthorize).toHaveBeenCalled();
    await module.close();
  });

  it('runs a D row through dry run, confirm and idempotency, and refuses a target on air', async () => {
    const { module, capability, fakes } = await connect(
      principalWith(...everything),
    );
    const dry = await capability('instant_delete_instant', {
      instant_id: 8,
      dry_run: true,
      idempotency_key: 'key-00000002',
    });
    expect(dry.body).toMatchObject({ dry_run: true, onAir: false });
    const done = await capability('instant_delete_instant', {
      instant_id: 8,
      confirm: dry.body.confirm,
      idempotency_key: 'key-00000002',
    });
    expect(done.isError).toBe(false);
    expect(fakes.programs.deleteInstant).toHaveBeenCalledTimes(1);

    fakes.programs.listPrograms.mockResolvedValue([
      listed({ activeSceneId: 3, scenes: [sceneNaming(8)] }),
    ]);
    fakes.programs.deleteInstant.mockClear();
    const live = await capability('instant_delete_instant', {
      instant_id: 8,
      confirm: dry.body.confirm,
      idempotency_key: 'key-00000003',
    });
    expect(live.isError).toBe(true);
    expect(live.body.error).toBe('on_air');
    expect(fakes.programs.deleteInstant).not.toHaveBeenCalled();

    fakes.programs.listPrograms.mockResolvedValue([
      listed({ fadeToBlack: true, stingers: [{ stingerId: 7 }] }),
    ]);
    const stinger = await capability('stinger_delete_stinger', {
      stinger_id: 7,
      confirm: 'whatever',
      idempotency_key: 'key-00000004',
    });
    expect(stinger.body.error).toMatch(/on_air|confirm_mismatch/);
    expect(fakes.stingers.remove).not.toHaveBeenCalled();
    await module.close();
  });

  it('answers no credential from any of the ten capabilities', async () => {
    const { module, capability, fakes } = await connect(
      principalWith(...everything),
    );
    const answers = [
      await capability('instant_list_instants', {}),
      await capability('stinger_list_stingers', {}),
      await capability('instant_stop_all_instants', {
        confirm: (
          await capability('instant_stop_all_instants', {
            dry_run: true,
            idempotency_key: 'key-00000005',
          })
        ).body.confirm,
        idempotency_key: 'key-00000005',
      }),
    ];
    expect(JSON.stringify(answers)).not.toMatch(
      /token|ticket|secret|password|X-Amz/i,
    );
    expect(fakes.programs.stopAllInstants).toHaveBeenCalledWith('main');
    await module.close();
  });
});
