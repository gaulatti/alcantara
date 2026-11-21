/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call -- tool answers are untyped JSON. */
import { Injectable } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { z } from 'zod';
import { ALCANTARA_PERMISSIONS } from '../auth/permissions';
import { ManagedMetricsService } from '../observability/managed-metrics.service';
import { ProgramService } from '../program/program.service';
import {
  MCP_ACTION_EXECUTOR,
  MCP_ATTRIBUTION,
  McpToolProvider,
  type McpPrincipal,
  type McpToolSpec,
} from './contract';
import { McpActionExecutor } from './mcp-action.executor';
import { MCP_IDEMPOTENCY_NOTE } from './mcp-action.shape';
import { McpRegistry } from './mcp-registry.service';

// The real registry call path with the real executor bound, through a fake
// McpServer that keeps the handlers the registry registers.

const writes: unknown[] = [];

@Injectable()
@McpToolProvider()
class Fakes {
  specs(): McpToolSpec[] {
    const base = {
      title: 'Fake',
      permission: ALCANTARA_PERMISSIONS.song.manage,
      firstClass: true,
      shape: { id: z.number().int() },
    };
    return [
      {
        ...base,
        name: 'fake_read',
        description: 'Reads.',
        tier: 'R',
        run: (args) => Promise.resolve({ result: { id: args.id }, audit: {} }),
      },
      {
        ...base,
        name: 'fake_write',
        description: 'Writes.',
        tier: 'W',
        run: (args) => {
          writes.push(args);
          return Promise.resolve({ result: { wrote: args.id }, audit: {} });
        },
      },
      {
        ...base,
        name: 'fake_on_air',
        description: 'Goes on air.',
        tier: 'A',
        dryRun: () =>
          Promise.resolve({
            summary: 's',
            affects: [],
            recoverable: false,
            onAir: true,
          }),
        confirmTarget: (args) =>
          Promise.resolve({ id: String(args.id), name: 'Thing' }),
        run: (args) => {
          writes.push(args);
          return Promise.resolve({ result: { aired: args.id }, audit: {} });
        },
      },
      {
        ...base,
        name: 'fake_delete',
        description: 'Deletes.',
        tier: 'D',
        firstClass: false,
        run: () => Promise.resolve({ result: { deleted: true }, audit: {} }),
      },
    ];
  }
}

type Handler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ text: string }>;
  isError?: boolean;
}>;
interface Registered {
  description: string;
  inputSchema: z.ZodRawShape;
  handler: Handler;
}

async function setup(withAttribution = false) {
  const attribution = {
    run: jest.fn(<T>(_actor: unknown, work: () => Promise<T>) => work()),
  };
  const module = await Test.createTestingModule({
    imports: [DiscoveryModule],
    providers: [
      McpRegistry,
      McpActionExecutor,
      { provide: MCP_ACTION_EXECUTOR, useExisting: McpActionExecutor },
      ManagedMetricsService,
      { provide: ProgramService, useValue: {} },
      ...(withAttribution
        ? [{ provide: MCP_ATTRIBUTION, useValue: attribution }]
        : []),
      Fakes,
    ],
  }).compile();
  await module.init();
  const tools = new Map<string, Registered>();
  const server = {
    registerTool: (
      name: string,
      config: { description: string; inputSchema: z.ZodRawShape },
      handler: Handler,
    ) => tools.set(name, { ...config, handler }),
  };
  const principal: McpPrincipal = {
    subject: 'sub',
    principalId: 'principal-1',
    permissions: new Set([
      ALCANTARA_PERMISSIONS.access,
      ALCANTARA_PERMISSIONS.song.manage,
    ]),
    client: 'claude-code',
  };
  const reauthorize = jest.fn(() => Promise.resolve(principal));
  module
    .get(McpRegistry)
    .register(server as never, principal, reauthorize as never);
  const call = async (name: string, args: Record<string, unknown>) => {
    const answer = await tools.get(name)!.handler(args);
    return {
      body: JSON.parse(answer.content[0].text) as Record<string, any>,
      isError: answer.isError === true,
    };
  };
  return {
    module,
    principal,
    tools,
    call,
    reauthorize,
    attribution,
    metrics: module.get(ManagedMetricsService),
  };
}

describe('MCP action framework through the registry', () => {
  beforeEach(() => {
    writes.length = 0;
  });

  it('advertises the framework fields, and the idempotency sentence on A and D only', async () => {
    const { module, tools, call } = await setup();
    expect(tools.get('fake_read')!.description).toBe('Reads.');
    expect(tools.get('fake_write')!.description).toBe('Writes.');
    expect(tools.get('fake_on_air')!.description).toBe(
      `Goes on air. ${MCP_IDEMPOTENCY_NOTE}`,
    );
    expect(Object.keys(tools.get('fake_read')!.inputSchema)).toEqual(['id']);
    expect(Object.keys(tools.get('fake_write')!.inputSchema)).toEqual([
      'id',
      'idempotency_key',
    ]);
    expect(Object.keys(tools.get('fake_on_air')!.inputSchema)).toEqual([
      'id',
      'dry_run',
      'confirm',
      'idempotency_key',
    ]);
    const listed = await call('list_capabilities', { query: 'fake_' });
    const byName = Object.fromEntries(
      listed.body.capabilities.map((c: { name: string }) => [c.name, c]),
    );
    expect(byName.fake_delete.description).toBe(
      `Deletes. ${MCP_IDEMPOTENCY_NOTE}`,
    );
    expect(byName.fake_write.description).toBe('Writes.');
    expect(byName.fake_delete.input_schema.required).toEqual([
      'id',
      'idempotency_key',
    ]);
    expect(byName.fake_read.input_schema.required).toEqual(['id']);
    expect(MCP_IDEMPOTENCY_NOTE).toContain('do not survive a backend restart');
    expect(MCP_IDEMPOTENCY_NOTE).toContain('10 minutes');
    await module.close();
  });

  it('runs a listed write and a capability through dry run, confirm and idempotency', async () => {
    const { module, call, reauthorize, attribution } = await setup();
    const dry = await call('fake_on_air', {
      id: 7,
      dry_run: true,
      idempotency_key: 'key-00000001',
    });
    expect(dry.body).toEqual({
      dry_run: true,
      summary: 's',
      affects: [],
      recoverable: false,
      onAir: true,
      confirm: '7 Thing',
    });
    expect(writes).toEqual([]);
    const missing = await call('fake_on_air', {
      id: 7,
      idempotency_key: 'key-00000001',
    });
    expect(missing.body.error).toBe('confirm_required');
    const aired = {
      id: 7,
      confirm: '7 Thing',
      idempotency_key: 'key-00000001',
    };
    expect((await call('fake_on_air', aired)).body).toEqual({ aired: 7 });
    expect((await call('fake_on_air', aired)).body).toEqual({ aired: 7 });
    expect(writes).toHaveLength(1);
    // An A call asked Pompeii again each time; the replay too.
    expect(reauthorize).toHaveBeenCalledTimes(4);
    const spaced = await call('fake_on_air', {
      ...aired,
      id: 8,
      confirm: '8 Thing',
      idempotency_key: 'key-00000002',
    });
    expect(spaced.body.error).toBe('rate_limited');
    expect(spaced.body.retry_after_seconds).toBeGreaterThan(0);
    // Through call_capability, a W runs the same path and an invalid call is refused.
    const viaCapability = await call('call_capability', {
      name: 'fake_write',
      arguments: { id: 3, idempotency_key: 'key-00000003' },
    });
    expect(viaCapability.body).toEqual({ wrote: 3 });
    const invalid = await call('call_capability', {
      name: 'fake_delete',
      arguments: { id: 3 },
    });
    expect(invalid.body.error).toBe('invalid');
    expect(attribution.run).not.toHaveBeenCalled();
    await module.close();
  });

  it('hands the attribution hook a W call and an A call, when one is bound', async () => {
    const { module, call, attribution } = await setup(true);
    await call('fake_write', { id: 1, idempotency_key: 'key-00000001' });
    expect(attribution.run).toHaveBeenCalledTimes(1);
    await call('fake_on_air', {
      id: 1,
      confirm: '1 Thing',
      idempotency_key: 'key-00000002',
    });
    expect(attribution.run).toHaveBeenCalledTimes(2);
    expect(attribution.run).toHaveBeenCalledWith(
      { principalId: 'principal-1', via: 'mcp', client: 'claude-code' },
      expect.any(Function),
    );
    await module.close();
  });

  it('counts every tier in /metrics output with bounded labels, each call once', async () => {
    const { module, call, metrics } = await setup();
    await call('fake_read', { id: 1 });
    await call('fake_read', { id: 'not a number' });
    await call('fake_write', { id: 1, idempotency_key: 'key-00000001' });
    await call('fake_write', { id: 1, idempotency_key: 'key-00000001' });
    await call('fake_on_air', { id: 1, idempotency_key: 'key-00000009' });
    await call('call_capability', { name: 'no_such_tool' });
    const text = await metrics.registry.metrics();
    const rows = text
      .split('\n')
      .filter((line) => line.startsWith('alcantara_mcp_requests_total{'))
      .map((line) => line.replace('alcantara_mcp_requests_total', ''));
    expect(rows.sort()).toEqual(
      [
        '{tool="fake_read",tier="R",result="ok"} 1',
        '{tool="fake_read",tier="R",result="invalid"} 1',
        '{tool="fake_write",tier="W",result="ok"} 2',
        '{tool="fake_on_air",tier="A",result="confirm_required"} 1',
        '{tool="call_capability",tier="R",result="not_found"} 1',
      ].sort(),
    );
    expect(text).not.toContain('key-0000');
    expect(text).not.toContain('principal-1');
    await module.close();
  });

  it('refuses a permission removed since listing before the executor, and counts it once', async () => {
    const { module, call, metrics, reauthorize, principal } = await setup();
    (principal.permissions as Set<string>).delete(
      ALCANTARA_PERMISSIONS.song.manage,
    );
    const { body } = await call('fake_write', {
      id: 1,
      idempotency_key: 'key-00000001',
    });
    expect(body.error).toBe('forbidden');
    expect(await metrics.registry.metrics()).toContain(
      'alcantara_mcp_requests_total{tool="fake_write",tier="W",result="forbidden"} 1',
    );
    expect(reauthorize).not.toHaveBeenCalled();
    await module.close();
  });
});
