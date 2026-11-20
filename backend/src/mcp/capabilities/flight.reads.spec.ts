import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ALCANTARA_PERMISSIONS } from '../../auth/permissions';
import { McpToolError, UNTRUSTED_NOTE } from '../contract';
import { asRest, rebuilt, specNamed } from './capabilities.testing';
import { buildFlight, clocked, cue, sequence } from './flight.testing';

// The two flight reads against the real controller, one set of fake services
// behind both: what the console is told is what the capability returns, with
// the user text (names, cues) under `untrusted`.

const ctx = { principal: {} as never };

describe('program_list_flight_sequences_by_id', () => {
  it('returns what the controller returns, user text isolated', async () => {
    const { controller, flights, specs } = buildFlight();
    const { result } = await specNamed(
      specs,
      'program_list_flight_sequences_by_id',
    ).run({ program_id: 'main' }, ctx);
    expect(rebuilt(result)).toEqual(
      asRest(await controller.listFlightSequencesById('main')),
    );
    expect(flights.listFlightSequences).toHaveBeenNthCalledWith(1, 'main');
    expect(flights.listFlightSequences).toHaveBeenNthCalledWith(2, 'main');
    expect(result).toMatchObject([
      {
        id: 4,
        revision: 1,
        isRunning: false,
        untrusted: { name: sequence.name, items: [cue] },
      },
      { id: 5, untrusted: { name: clocked.name } },
    ]);
    // Nothing a person typed sits beside the fields of the service.
    for (const row of result as Array<Record<string, unknown>>) {
      expect(row).not.toHaveProperty('name');
      expect(row).not.toHaveProperty('items');
    }
  });

  it('is a read with the console permission and the untrusted note', () => {
    const { specs } = buildFlight();
    const reads = specs.filter((spec) => spec.tier === 'R');
    expect(reads.map((spec) => spec.name)).toEqual([
      'program_list_flight_sequences_by_id',
      'program_preflight_flight_sequence_by_id',
    ]);
    for (const spec of reads) {
      expect(spec.permission).toBe(ALCANTARA_PERMISSIONS.flight.read);
      expect(spec.firstClass).toBe(false);
      expect(spec.dryRun).toBeUndefined();
      expect(spec.confirmTarget).toBeUndefined();
      expect(spec.description.endsWith(UNTRUSTED_NOTE)).toBe(true);
    }
  });

  it('reports an unknown program as not_found', async () => {
    const { flights, specs } = buildFlight();
    flights.listFlightSequences.mockRejectedValue(
      new NotFoundException('program not found'),
    );
    await expect(
      specNamed(specs, 'program_list_flight_sequences_by_id').run(
        { program_id: 'nope' },
        ctx,
      ),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('withholds an answer that carries a credential, whatever the service returned', async () => {
    const { flights, specs } = buildFlight();
    const run = () =>
      specNamed(specs, 'program_list_flight_sequences_by_id').run(
        { program_id: 'main' },
        ctx,
      );
    flights.listFlightSequences.mockResolvedValue([
      { ...sequence, token: 'planted-secret-value' },
    ]);
    await expect(run()).rejects.toBeInstanceOf(McpToolError);
    await expect(run()).rejects.toMatchObject({ code: 'unavailable' });
    flights.listFlightSequences.mockResolvedValue([
      {
        ...sequence,
        items: [
          {
            ...cue,
            metadataPatch: {
              url: 'https://cdn.example/a.mp3?X-Amz-Signature=planted-secret-value',
            },
          },
        ],
      },
    ]);
    await expect(run()).rejects.toMatchObject({ code: 'unavailable' });
  });
});

describe('program_preflight_flight_sequence_by_id', () => {
  it('returns what the controller returns, with the same service call', async () => {
    const { controller, flights, specs } = buildFlight();
    const { result } = await specNamed(
      specs,
      'program_preflight_flight_sequence_by_id',
    ).run({ program_id: 'main', sequence_id: 5 }, ctx);
    expect(rebuilt(result)).toEqual(
      asRest(await controller.preflightFlightSequenceById('main', '5')),
    );
    expect(flights.preflightFlightSequence).toHaveBeenNthCalledWith(
      1,
      'main',
      5,
    );
    expect(flights.preflightFlightSequence).toHaveBeenNthCalledWith(
      2,
      'main',
      5,
    );
    expect(result).toEqual({
      programId: 'main',
      ready: false,
      issues: ['Item 1: song unavailable'],
    });
  });

  it("reports the console's refusals as MCP codes", async () => {
    const { flights, specs } = buildFlight();
    const spec = specNamed(specs, 'program_preflight_flight_sequence_by_id');
    flights.preflightFlightSequence.mockRejectedValueOnce(
      new BadRequestException('not a clocked log'),
    );
    await expect(
      spec.run({ program_id: 'main', sequence_id: 4 }, ctx),
    ).rejects.toMatchObject({ code: 'invalid', message: 'not a clocked log' });
    flights.preflightFlightSequence.mockRejectedValueOnce(
      new NotFoundException('flight sequence not found'),
    );
    await expect(
      spec.run({ program_id: 'main', sequence_id: 9 }, ctx),
    ).rejects.toMatchObject({ code: 'not_found' });
  });
});
