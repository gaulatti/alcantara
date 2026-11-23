/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access -- tool answers are untyped JSON. */
import { DiscoveryModule } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { z } from 'zod';
import { ALCANTARA_PERMISSIONS } from '../../auth/permissions';
import { ManagedMetricsService } from '../../observability/managed-metrics.service';
import { FlightService } from '../../program/flight.service';
import { ProgramService } from '../../program/program.service';
import { MCP_ACTION_EXECUTOR } from '../contract';
import { McpActionExecutor } from '../mcp-action.executor';
import { McpRegistry } from '../mcp-registry.service';
import { fakeServices, principalWith, stateOf } from './capabilities.testing';
import { FlightMcpTools } from './flight';
import { clocked, fakeFlight, sequence } from './flight.testing';

// The flight provider found through Nest discovery and run on the registry's
// real call path, executor included: a caller sees and may call only what its
// flight permissions allow, and an A or D capability goes through dry run,
// confirm, idempotency and its own on-air refusal.

type Handler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ text: string }>;
  isError?: boolean;
}>;

const flight = ALCANTARA_PERMISSIONS.flight;
const FULL = principalWith(
  ALCANTARA_PERMISSIONS.access,
  flight.read,
  flight.manage,
  flight.operate,
);
const KEY = 'key-00000001';

async function connect(principal: ReturnType<typeof principalWith>) {
  const f = fakeServices();
  const flights = fakeFlight();
  const module = await Test.createTestingModule({
    imports: [DiscoveryModule],
    providers: [
      McpRegistry,
      McpActionExecutor,
      { provide: MCP_ACTION_EXECUTOR, useExisting: McpActionExecutor },
      ManagedMetricsService,
      { provide: ProgramService, useValue: f.programs },
      { provide: FlightService, useValue: flights },
      FlightMcpTools,
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
  return { module, call, capability, f, flights, reauthorize };
}

const flightNames = async (call: Awaited<ReturnType<typeof connect>>['call']) =>
  (
    (await call('list_capabilities', { limit: 100 })).body
      .capabilities as Array<{ name: string }>
  )
    .map((c) => c.name)
    .filter((name) => /flight|rundown|tagged_log/.test(name));

describe('flight capabilities through the registry', () => {
  it('lists all 14 to a caller holding every flight permission', async () => {
    const { module, call } = await connect(FULL);
    expect(await flightNames(call)).toHaveLength(14);
    await module.close();
  });

  it('lists only the reads to a caller who holds flight.read, and runs them', async () => {
    const { module, call, capability } = await connect(
      principalWith(ALCANTARA_PERMISSIONS.access, flight.read),
    );
    expect(await flightNames(call)).toEqual([
      'program_list_flight_sequences_by_id',
      'program_preflight_flight_sequence_by_id',
    ]);
    const listed = await capability('program_list_flight_sequences_by_id', {
      program_id: 'main',
    });
    expect(listed.isError).toBe(false);
    expect(listed.body[0].untrusted.name).toBe(sequence.name);
    await module.close();
  });

  it.each([
    ['program_list_flight_sequences_by_id', { program_id: 'main' }],
    [
      'program_create_flight_sequence_by_id',
      { program_id: 'main', name: 'x', idempotency_key: KEY },
    ],
    [
      'program_delete_flight_sequence_by_id',
      {
        program_id: 'main',
        sequence_id: 4,
        confirm: 'c',
        idempotency_key: KEY,
      },
    ],
    [
      'program_go_flight_by_id',
      { program_id: 'main', confirm: 'c', idempotency_key: KEY },
    ],
  ])(
    'does not list %s for a caller without its permission and refuses the call',
    async (name, args) => {
      const { module, call, capability, flights } = await connect(
        principalWith(ALCANTARA_PERMISSIONS.access),
      );
      expect(await flightNames(call)).toEqual([]);
      const refused = await capability(name, args);
      expect(refused.isError).toBe(true);
      expect(refused.body.error).toBe('forbidden');
      expect(flights.listFlightSequences).not.toHaveBeenCalled();
      expect(flights.createFlightSequence).not.toHaveBeenCalled();
      expect(flights.deleteFlightSequence).not.toHaveBeenCalled();
      expect(flights.go).not.toHaveBeenCalled();
      await module.close();
    },
  );

  it('runs an A capability through dry run, confirm and idempotency, asking Pompeii again', async () => {
    const { module, capability, flights, reauthorize } = await connect(FULL);
    const dry = await capability('program_go_flight_by_id', {
      program_id: 'main',
      dry_run: true,
      idempotency_key: KEY,
    });
    expect(dry.body).toMatchObject({
      dry_run: true,
      onAir: true,
      confirm:
        'main scene:null fade:0 song:0 queue:0 flight:none running:0 cue:none',
    });
    expect(flights.go).not.toHaveBeenCalled();
    const missing = await capability('program_go_flight_by_id', {
      program_id: 'main',
      idempotency_key: KEY,
    });
    expect(missing.body.error).toBe('confirm_required');
    const done = await capability('program_go_flight_by_id', {
      program_id: 'main',
      confirm: dry.body.confirm,
      idempotency_key: KEY,
    });
    expect(done.isError).toBe(false);
    expect(done.body).toEqual({ ok: true });
    expect(flights.go).toHaveBeenCalledTimes(1);
    expect(reauthorize).toHaveBeenCalled();
    await module.close();
  });

  it('refuses an A capability whose plan went stale, as confirm_mismatch, and cuts nothing', async () => {
    const { module, capability, f, flights } = await connect(FULL);
    const dry = await capability('program_stop_flight_by_id', {
      program_id: 'main',
      dry_run: true,
      idempotency_key: KEY,
    });
    f.programs.getState.mockResolvedValue(
      stateOf({ activeFlightSequenceId: 4 }),
    );
    flights.listFlightSequences.mockResolvedValue([
      { ...sequence, isRunning: true, activeItemId: 'c1' },
      clocked,
    ]);
    const stale = await capability('program_stop_flight_by_id', {
      program_id: 'main',
      confirm: dry.body.confirm,
      idempotency_key: KEY,
    });
    expect(stale.isError).toBe(true);
    expect(stale.body.error).toBe('confirm_mismatch');
    expect(flights.stop).not.toHaveBeenCalled();
    await module.close();
  });

  it('refuses the D capability with on_air for a running sequence, after a correct confirm, and writes nothing', async () => {
    const { module, capability, flights } = await connect(FULL);
    flights.listFlightSequences.mockResolvedValue([
      { ...sequence, isRunning: true, activeItemId: 'c1' },
      clocked,
    ]);
    const args = { program_id: 'main', sequence_id: 4 };
    const dry = await capability('program_delete_flight_sequence_by_id', {
      ...args,
      dry_run: true,
      idempotency_key: 'key-00000002',
    });
    expect(dry.body.onAir).toBe(true);
    expect(dry.body.recoverable).toBe(false);
    expect(dry.body.summary).toMatch(
      /^REFUSED \(on_air\): flight sequence 4 is running on main/,
    );
    const refused = await capability('program_delete_flight_sequence_by_id', {
      ...args,
      confirm: dry.body.confirm,
      idempotency_key: 'key-00000002',
    });
    expect(refused.isError).toBe(true);
    expect(refused.body.error).toBe('on_air');
    expect(flights.deleteFlightSequence).not.toHaveBeenCalled();
    await module.close();
  });

  it('answers a W capability with the sequence and its text under untrusted', async () => {
    const { module, capability } = await connect(FULL);
    const created = await capability('program_create_flight_sequence_by_id', {
      program_id: 'main',
      name: 'Morning',
      idempotency_key: KEY,
    });
    expect(created.isError).toBe(false);
    expect(created.body.untrusted.name).toBe(sequence.name);
    expect(created.body).not.toHaveProperty('name');
    await module.close();
  });
});
