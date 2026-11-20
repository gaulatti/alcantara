/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call -- tool answers are untyped JSON. */
import { BadRequestException } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import type { z } from 'zod';
import { AsRunController } from '../../as-run/as-run.controller';
import { AsRunService } from '../../as-run/as-run.service';
import { ALCANTARA_PERMISSIONS } from '../../auth/permissions';
import { REQUIRED_PERMISSION_KEY } from '../../auth/require-permission.decorator';
import { ManagedMetricsService } from '../../observability/managed-metrics.service';
import { ProgramService } from '../../program/program.service';
import { MCP_ACTION_EXECUTOR, UNTRUSTED_NOTE } from '../contract';
import { McpActionExecutor } from '../mcp-action.executor';
import { McpRegistry } from '../mcp-registry.service';
import { AS_RUN_EXPORT_MAX_ROWS, AsRunMcpTools } from './as-run';
import { principalWith, specNamed } from './capabilities.testing';

// as-run_export (#226): the console's as-run download as a read capability.
// One fake service behind the real controller and the capability.

const CSV = 'id,title\nr1,"Anthem, The"';
const asRun = { export: jest.fn(), countExportRows: jest.fn() };
const controller = new AsRunController(asRun as never);
const spec = specNamed(
  new AsRunMcpTools(asRun as never).specs(),
  'as-run_export',
);
const ctx = { principal: principalWith(ALCANTARA_PERMISSIONS.radio.read) };

beforeEach(() => {
  jest.clearAllMocks();
  asRun.export.mockResolvedValue(CSV);
  asRun.countExportRows.mockResolvedValue(10);
});

describe('as-run_export', () => {
  it('is the R row of radio.read, the controller permission, a capability', () => {
    expect(spec).toMatchObject({
      permission: ALCANTARA_PERMISSIONS.radio.read,
      tier: 'R',
      firstClass: false,
    });
    expect(spec.description).toContain(UNTRUSTED_NOTE);
    expect(Reflect.getMetadata(REQUIRED_PERMISSION_KEY, AsRunController)).toBe(
      spec.permission,
    );
  });

  it('exports what the controller exports, with the same query, the file text under untrusted', async () => {
    const query = {
      from: '2026-11-01T00:00:00Z',
      to: '2026-11-02T00:00:00Z',
      format: 'soundexchange' as const,
      inferred: 'only' as const,
    };
    const { result } = await spec.run({ program_id: 'main', ...query }, ctx);
    expect(asRun.export).toHaveBeenLastCalledWith('main', query);
    const body = await controller.export(
      'main',
      query.from,
      query.to,
      query.format,
      undefined,
      query.inferred,
    );
    expect(asRun.export).toHaveBeenLastCalledWith('main', query);
    expect(result).toEqual({
      program_id: 'main',
      format: 'soundexchange',
      untrusted: { csv: body },
    });
  });

  it('defaults to csv, as the controller does, and sends no window when none is given', async () => {
    const { result } = await spec.run({ program_id: 'main' }, ctx);
    expect(asRun.export).toHaveBeenCalledWith('main', {
      from: undefined,
      to: undefined,
      format: undefined,
      inferred: undefined,
    });
    expect(result).toEqual({
      program_id: 'main',
      format: 'csv',
      untrusted: { csv: CSV },
    });
  });

  it("reports the service's refusals as the closed invalid code", async () => {
    asRun.export.mockRejectedValue(
      new BadRequestException('inferred applies only to format=soundexchange'),
    );
    await expect(
      spec.run({ program_id: 'main', inferred: 'only' }, ctx),
    ).rejects.toMatchObject({ code: 'invalid' });
  });

  it('counts the window first, with the export query, and exports at exactly the cap', async () => {
    expect(AS_RUN_EXPORT_MAX_ROWS).toBe(5000);
    asRun.countExportRows.mockResolvedValue(5000);
    const query = {
      from: '2026-11-01',
      to: undefined,
      format: 'csv',
      inferred: undefined,
    };
    const { result } = await spec.run(
      { program_id: 'main', from: '2026-11-01', format: 'csv' },
      ctx,
    );
    expect(asRun.countExportRows).toHaveBeenCalledWith('main', query);
    expect(asRun.export).toHaveBeenCalledWith('main', query);
    expect(result).toMatchObject({ untrusted: { csv: CSV } });
  });

  it('refuses a window over the cap as invalid, with its row count, and exports nothing', async () => {
    asRun.countExportRows.mockResolvedValue(5001);
    await expect(spec.run({ program_id: 'main' }, ctx)).rejects.toMatchObject({
      code: 'invalid',
      message: expect.stringMatching(/holds 5001 rows.*at most 5000.*narrow/),
    });
    expect(asRun.export).not.toHaveBeenCalled();
  });

  it('leaves the console download uncapped: the controller never counts', async () => {
    asRun.countExportRows.mockResolvedValue(1_000_000);
    await expect(controller.export('main')).resolves.toBe(CSV);
    expect(asRun.countExportRows).not.toHaveBeenCalled();
  });

  it('bounds its arguments to what the service accepts', () => {
    const shape = spec.shape;
    expect(shape.format.safeParse('xml').success).toBe(false);
    expect(shape.inferred.safeParse('maybe').success).toBe(false);
    expect(shape.program_id.safeParse('').success).toBe(false);
    expect(shape.from.safeParse('x'.repeat(41)).success).toBe(false);
  });
});

describe('as-run_export through the registry', () => {
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
        { provide: ProgramService, useValue: {} },
        { provide: AsRunService, useValue: asRun },
        AsRunMcpTools,
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
      jest.fn(() => Promise.resolve(principal)) as never,
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

  it('is listed and runs for radio.read, with no confirm or key', async () => {
    const { module, call } = await connect(
      principalWith(
        ALCANTARA_PERMISSIONS.access,
        ALCANTARA_PERMISSIONS.radio.read,
      ),
    );
    const listed = await call('list_capabilities', { limit: 100 });
    expect(
      listed.body.capabilities.map((c: { name: string }) => c.name),
    ).toContain('as-run_export');
    const done = await call('call_capability', {
      name: 'as-run_export',
      arguments: { program_id: 'main' },
    });
    expect(done.isError).toBe(false);
    expect(done.body.untrusted.csv).toBe(CSV);
    await module.close();
  });

  it('is neither listed nor callable without radio.read', async () => {
    const { module, call } = await connect(
      principalWith(ALCANTARA_PERMISSIONS.access),
    );
    const listed = await call('list_capabilities', { limit: 100 });
    expect(
      listed.body.capabilities.map((c: { name: string }) => c.name),
    ).not.toContain('as-run_export');
    const refused = await call('call_capability', {
      name: 'as-run_export',
      arguments: { program_id: 'main' },
    });
    expect(refused.isError).toBe(true);
    expect(refused.body.error).toBe('forbidden');
    expect(asRun.export).not.toHaveBeenCalled();
    await module.close();
  });
});
