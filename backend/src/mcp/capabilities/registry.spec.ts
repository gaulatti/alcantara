/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access -- tool answers are untyped JSON. */
import { DiscoveryModule } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { z } from 'zod';
import { ALCANTARA_PERMISSIONS } from '../../auth/permissions';
import { LayoutsService } from '../../layouts/layouts.service';
import { MediaGroupsService } from '../../media-groups/media-groups.service';
import { ManagedMetricsService } from '../../observability/managed-metrics.service';
import { ProgramTemplateService } from '../../program/program-template.service';
import { ProgramService } from '../../program/program.service';
import { ScenesService } from '../../scenes/scenes.service';
import { MCP_ACTION_EXECUTOR } from '../contract';
import { McpActionExecutor } from '../mcp-action.executor';
import { McpRegistry } from '../mcp-registry.service';
import { fakeServices, principalWith, stateOf } from './capabilities.testing';
import { LayoutsMcpTools } from './layouts';
import { MediaGroupsMcpTools } from './media-groups';
import { PompeiiService } from '../../auth/pompeii.service';
import { ProgramMcpTools } from './program';
import { ScenesMcpTools } from './scenes';

// The providers found through Nest discovery and run on the registry's real
// call path, executor included: a caller sees and may call only what its
// permissions allow, and an A or D capability goes through dry run, confirm,
// idempotency and its own on-air refusal.

type Handler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ text: string }>;
  isError?: boolean;
}>;

const permissions = ALCANTARA_PERMISSIONS;
const EVERYTHING = principalWith(
  permissions.access,
  permissions.program.read,
  permissions.program.manage,
  permissions.program.operate,
  permissions.scene.read,
  permissions.scene.manage,
  permissions.scene.operate,
  permissions.layout.read,
  permissions.layout.manage,
  permissions.media.read,
  permissions.media.manage,
);

async function connect(principal: ReturnType<typeof principalWith>) {
  const f = fakeServices();
  const module = await Test.createTestingModule({
    imports: [DiscoveryModule],
    providers: [
      McpRegistry,
      McpActionExecutor,
      { provide: MCP_ACTION_EXECUTOR, useExisting: McpActionExecutor },
      ManagedMetricsService,
      { provide: ProgramService, useValue: f.programs },
      { provide: ProgramTemplateService, useValue: f.templates },
      { provide: PompeiiService, useValue: { teamId: 7 } },
      { provide: ScenesService, useValue: f.scenes },
      { provide: LayoutsService, useValue: f.layouts },
      { provide: MediaGroupsService, useValue: f.groups },
      ProgramMcpTools,
      ScenesMcpTools,
      LayoutsMcpTools,
      MediaGroupsMcpTools,
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
  return { module, call, capability, f, reauthorize };
}

const names = async (call: Awaited<ReturnType<typeof connect>>['call']) => {
  const listed = await call('list_capabilities', { limit: 100 });
  return (listed.body.capabilities as Array<{ name: string }>).map(
    (c) => c.name,
  );
};

describe('area capabilities through the registry', () => {
  it('shows all 47 to a caller holding every permission of the area, and only those', async () => {
    const { module, call } = await connect(EVERYTHING);
    const listed = await names(call);
    expect(
      listed.filter((name) =>
        /^(program_|scene_|layout_|media_group_)/.test(name),
      ).length,
    ).toBe(47);
    expect(listed).not.toContain('program_list_flight_sequences_by_id');
    await module.close();
  });

  it('shows and runs only the reads of a caller who holds read permissions', async () => {
    const { module, call, capability } = await connect(
      principalWith(permissions.access, permissions.scene.read),
    );
    expect((await names(call)).filter((n) => n.startsWith('scene_'))).toEqual([
      'scene_find_all',
      'scene_find_one',
    ]);
    const found = await capability('scene_find_all', {});
    expect(found.isError).toBe(false);
    expect(found.body[0].untrusted.name).toBe('Evening news');
    await module.close();
  });

  it.each([
    ['program_list_programs', {}],
    ['layout_find_all', {}],
    ['media_group_find_all', {}],
    [
      'scene_create',
      { name: 'S', layout_id: 2, idempotency_key: 'key-00000001' },
    ],
    [
      'scene_update_chyron',
      {
        scene_id: 3,
        chyron_text: 'x',
        confirm: 'c',
        idempotency_key: 'key-00000001',
      },
    ],
    [
      'scene_remove',
      { scene_id: 3, confirm: 'c', idempotency_key: 'key-00000001' },
    ],
    [
      'layout_remove',
      { layout_id: 2, confirm: 'c', idempotency_key: 'key-00000001' },
    ],
    [
      'program_delete_program',
      { program_id: 'main', confirm: 'c', idempotency_key: 'key-00000001' },
    ],
  ])(
    'does not list %s for a caller without its permission and refuses the call',
    async (name, args) => {
      const { module, call, capability, f } = await connect(
        principalWith(permissions.access),
      );
      expect(await names(call)).not.toContain(name);
      const refused = await capability(name, args);
      expect(refused.isError).toBe(true);
      expect(refused.body.error).toBe('forbidden');
      expect(f.scenes.remove).not.toHaveBeenCalled();
      expect(f.layouts.remove).not.toHaveBeenCalled();
      expect(f.programs.deleteProgram).not.toHaveBeenCalled();
      await module.close();
    },
  );

  it('runs an A capability through dry run, confirm and idempotency, asking Pompeii again', async () => {
    const { module, capability, f, reauthorize } = await connect(EVERYTHING);
    const dry = await capability('program_take_program_off_air_by_id', {
      program_id: 'main',
      dry_run: true,
      idempotency_key: 'key-00000001',
    });
    expect(dry.body).toMatchObject({
      dry_run: true,
      onAir: true,
      confirm: 'main scene:null fade:0 song:0 queue:0',
    });
    expect(f.programs.takeProgramOffAir).not.toHaveBeenCalled();
    const missing = await capability('program_take_program_off_air_by_id', {
      program_id: 'main',
      idempotency_key: 'key-00000001',
    });
    expect(missing.body.error).toBe('confirm_required');
    const done = await capability('program_take_program_off_air_by_id', {
      program_id: 'main',
      confirm: dry.body.confirm,
      idempotency_key: 'key-00000001',
    });
    expect(done.isError).toBe(false);
    expect(done.body.program_id).toBe('main');
    expect(f.programs.takeProgramOffAir).toHaveBeenCalledTimes(1);
    expect(reauthorize).toHaveBeenCalled();
    await module.close();
  });

  it('refuses a D capability with on_air for a live target, after a correct confirm, and writes nothing', async () => {
    const { module, capability, f } = await connect(EVERYTHING);
    f.programs.listPrograms.mockResolvedValue([stateOf({ activeSceneId: 3 })]);
    const dry = await capability('scene_remove', {
      scene_id: 3,
      dry_run: true,
      idempotency_key: 'key-00000002',
    });
    expect(dry.body.onAir).toBe(true);
    expect(dry.body.summary).toMatch(
      /^REFUSED \(on_air\): scene 3 is on air on main/,
    );
    expect(dry.body.recoverable).toBe(false);
    const refused = await capability('scene_remove', {
      scene_id: 3,
      confirm: dry.body.confirm,
      idempotency_key: 'key-00000002',
    });
    expect(refused.isError).toBe(true);
    expect(refused.body.error).toBe('on_air');
    expect(f.scenes.remove).not.toHaveBeenCalled();
    await module.close();
  });
});
