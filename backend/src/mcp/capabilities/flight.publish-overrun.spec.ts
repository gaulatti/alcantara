import { ALCANTARA_PERMISSIONS } from '../../auth/permissions';
import { callerWith } from './broadcast.testing';
import { specNamed } from './capabilities.testing';
import { buildFlight, clocked } from './flight.testing';

// #788 (MCP parity, item 3): the desk asks "Publish anyway" before publishing a block that overruns a fixed start.
// program_publish_flight_sequence_by_id now says so in its dry run and refuses unless accept_overrun is true; the
// overrun is the desk's rule over the stored lengths of the program team's songs. Fictional rows only.

const ctx = callerWith(
  ALCANTARA_PERMISSIONS.flight.manage,
  ALCANTARA_PERMISSIONS.flight.read,
  ALCANTARA_PERMISSIONS.program.read,
);
const main = { program_id: 'main' };

function overrunning() {
  const f = buildFlight();
  const items = [
    { id: 'a', kind: 'playSong', songId: 7, clockOffsetSeconds: 0 },
    { id: 'b', kind: 'playSong', songId: 8, clockOffsetSeconds: 180 },
  ];
  f.flights.listFlightSequences.mockResolvedValue([{ ...clocked, items }]);
  const findMany = jest.fn().mockResolvedValue([
    { id: 7, durationMs: 245_000 },
    { id: 8, durationMs: 200_000 },
  ]);
  f.flights.programSongDb.mockResolvedValue({ song: { findMany } });
  return { f, findMany, spec: specNamed(f.specs, 'program_publish_flight_sequence_by_id') };
}

describe('program_publish_flight_sequence_by_id and an overrun', () => {
  it('reports the overrun in the dry run and refuses to publish it without accept_overrun', async () => {
    const { f, findMany, spec } = overrunning();
    const args = { ...main, sequence_id: 5, revision: 1 };
    const plan = (await spec.dryRun!(args, ctx)) as unknown as {
      summary: string;
      overrunMs: number;
    };
    expect(plan.overrunMs).toBe(65_000);
    expect(plan.summary).toMatch(
      /^REFUSED \(on_air\): This block overruns a fixed start: 01:05 of content is cut at the next fixed start\./,
    );
    await expect(spec.run(args, ctx)).rejects.toMatchObject({
      code: 'on_air',
    });
    expect(f.flights.programSongDb).toHaveBeenCalledWith('validate', 'main');
    expect(findMany).toHaveBeenCalledWith({
      where: { id: { in: [7, 8] } },
      select: { id: true, durationMs: true },
    });
    expect(f.flights.publishFlightSequence).not.toHaveBeenCalled();
  });

  it('publishes it as it is with accept_overrun, answering as the console does', async () => {
    const { f, spec } = overrunning();
    const args = { ...main, sequence_id: 5, revision: 1, accept_overrun: true };
    const plan = await spec.dryRun!(args, ctx);
    expect(plan.summary).toMatch(
      /01:05 of content is cut at the next fixed start; publishing it as it is \(accept_overrun\)\.$/,
    );
    const done = await spec.run(args, ctx);
    expect(f.flights.publishFlightSequence).toHaveBeenCalledWith('main', 5, 1);
    expect(JSON.stringify(done.result)).not.toContain('overrunMs');
  });

  it('publishes a block that fits without asking, and reads no songs for a block with none', async () => {
    const f = buildFlight();
    f.flights.listFlightSequences.mockResolvedValue([
      { ...clocked, items: [{ id: 'x', kind: 'stopSong', clockOffsetSeconds: 0 }] },
    ]);
    const spec = specNamed(f.specs, 'program_publish_flight_sequence_by_id');
    const plan = (await spec.dryRun!(
      { ...main, sequence_id: 5, revision: 1 },
      ctx,
    )) as unknown as { summary: string; overrunMs: number };
    expect(plan.overrunMs).toBeUndefined();
    expect(plan.summary).not.toMatch(/REFUSED|cut at the next fixed start/);
    await spec.run({ ...main, sequence_id: 5, revision: 1 }, ctx);
    expect(f.flights.programSongDb).not.toHaveBeenCalled();
    expect(f.flights.publishFlightSequence).toHaveBeenCalled();
  });
});
