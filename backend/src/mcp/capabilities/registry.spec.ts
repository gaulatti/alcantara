/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call -- tool answers are untyped JSON. */
import { DiscoveryModule } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { z } from 'zod';
import { ALCANTARA_PERMISSIONS } from '../../auth/permissions';
import { LayoutsService } from '../../layouts/layouts.service';
import { MediaGroupsService } from '../../media-groups/media-groups.service';
import { ManagedMetricsService } from '../../observability/managed-metrics.service';
import { ProgramService } from '../../program/program.service';
import { ScenesService } from '../../scenes/scenes.service';
import { MCP_ACTION_EXECUTOR } from '../contract';
import { McpActionExecutor } from '../mcp-action.executor';
import { McpRegistry } from '../mcp-registry.service';
import { layout, principalWith, scene } from './capabilities.testing';
import { LayoutsMcpTools } from './layouts';
import { MediaGroupsMcpTools } from './media-groups';
import { ProgramMcpTools } from './program';
import { ScenesMcpTools } from './scenes';

// The providers found through Nest discovery and run on the registry's real
// call path: a caller sees and may call only what its permissions allow.

type Handler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ text: string }>;
  isError?: boolean;
}>;

async function connect(principal: ReturnType<typeof principalWith>) {
  const module = await Test.createTestingModule({
    imports: [DiscoveryModule],
    providers: [
      McpRegistry,
      McpActionExecutor,
      { provide: MCP_ACTION_EXECUTOR, useExisting: McpActionExecutor },
      ManagedMetricsService,
      { provide: ProgramService, useValue: { listPrograms: jest.fn() } },
      {
        provide: ScenesService,
        useValue: { findAll: jest.fn().mockResolvedValue([scene]) },
      },
      {
        provide: LayoutsService,
        useValue: { findAll: jest.fn().mockResolvedValue([layout]) },
      },
      { provide: MediaGroupsService, useValue: {} },
      ProgramMcpTools,
      ScenesMcpTools,
      LayoutsMcpTools,
      MediaGroupsMcpTools,
    ],
  }).compile();
  await module.init();
  const tools = new Map<string, Handler>();
  module.get(McpRegistry).register(
    {
      registerTool: (
        name: string,
        _config: { inputSchema: z.ZodRawShape },
        handler: Handler,
      ) => tools.set(name, handler),
    } as never,
    principal,
    (() => Promise.resolve(principal)) as never,
  );
  const call = async (name: string, args: Record<string, unknown>) => {
    const answer = await tools.get(name)!(args);
    return {
      body: JSON.parse(answer.content[0].text),
      isError: answer.isError === true,
    };
  };
  return { module, call };
}

describe('area capabilities through the registry', () => {
  it('lists and runs a read the caller holds the permission for', async () => {
    const { module, call } = await connect(
      principalWith(
        ALCANTARA_PERMISSIONS.access,
        ALCANTARA_PERMISSIONS.scene.read,
      ),
    );
    const listed = await call('list_capabilities', { limit: 100 });
    const names = listed.body.capabilities.map((c: { name: string }) => c.name);
    expect(names).toEqual(
      expect.arrayContaining(['scene_find_all', 'scene_find_one']),
    );
    expect(names).not.toContain('layout_find_all');
    expect(names).not.toContain('program_list_programs');
    expect(names).not.toContain('media_group_find_all');
    const found = await call('call_capability', {
      name: 'scene_find_all',
      arguments: {},
    });
    expect(found.isError).toBe(false);
    expect(found.body[0].untrusted.name).toBe('Evening news');
    await module.close();
  });

  it('refuses a read the caller does not hold the permission for', async () => {
    const { module, call } = await connect(
      principalWith(ALCANTARA_PERMISSIONS.access),
    );
    const refused = await call('call_capability', {
      name: 'layout_find_all',
      arguments: {},
    });
    expect(refused.isError).toBe(true);
    expect(refused.body.error).toBe('forbidden');
    const listed = await call('list_capabilities', { query: 'layout_' });
    expect(listed.body.total).toBe(0);
    await module.close();
  });

  it('shows every read of the area to a caller holding all four read permissions', async () => {
    const { module, call } = await connect(
      principalWith(
        ALCANTARA_PERMISSIONS.access,
        ALCANTARA_PERMISSIONS.program.read,
        ALCANTARA_PERMISSIONS.scene.read,
        ALCANTARA_PERMISSIONS.layout.read,
        ALCANTARA_PERMISSIONS.media.read,
      ),
    );
    const listed = await call('list_capabilities', { limit: 100 });
    const names: string[] = listed.body.capabilities.map(
      (c: { name: string }) => c.name,
    );
    for (const name of [
      'program_list_programs',
      'program_get_staged_scene_by_id',
      'scene_find_all',
      'scene_find_one',
      'layout_find_all',
      'layout_find_one',
      'media_group_find_all',
    ])
      expect(names).toContain(name);
    await module.close();
  });
});
