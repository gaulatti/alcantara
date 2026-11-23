/* eslint-disable @typescript-eslint/no-unsafe-assignment -- the services are exercised through loosely typed fakes. */
import { specNamed, stateOf } from './capabilities.testing';
import { buildFlight, clocked, sequence } from './flight.testing';

// Step 0 of the one D row of gaulatti/alcantara#215: what the console does
// when the sequence is running, active or queued to air, and what this
// capability does instead. The console deletes in every one of these cases
// (a running sequence is stopped and the song playing is cut); the capability
// refuses with on_air, and its dry run says what would be lost.

const ctx = { principal: {} as never };
const NAME = 'program_delete_flight_sequence_by_id';
const args = { program_id: 'main', sequence_id: 4 };
const queuedArgs = { program_id: 'main', sequence_id: 5 };
const hour = 3_600_000;

async function refused(
  prepare: (f: ReturnType<typeof buildFlight>) => void,
  words: RegExp,
  callArgs: Record<string, unknown> = args,
) {
  const f = buildFlight();
  prepare(f);
  const spec = specNamed(f.specs, NAME);
  const plan = await spec.dryRun!(callArgs, ctx);
  expect(plan.onAir).toBe(true);
  expect(plan.recoverable).toBe(false);
  expect(plan.summary).toMatch(/^REFUSED \(on_air\): /);
  expect(plan.summary).toMatch(words);
  await expect(spec.run(callArgs, ctx)).rejects.toMatchObject({
    code: 'on_air',
    message: expect.stringMatching(words),
  });
  expect(f.flights.deleteFlightSequence).not.toHaveBeenCalled();
}

describe(NAME, () => {
  it('is refused with on_air while the sequence is running', () =>
    refused(
      (f) =>
        f.flights.listFlightSequences.mockResolvedValue([
          { ...sequence, isRunning: true, activeItemId: 'c1' },
          clocked,
        ]),
      /flight sequence 4 is running on main/,
    ));

  it('is refused with on_air while it is the active sequence of the program', () =>
    refused(
      (f) =>
        f.f.programs.getState.mockResolvedValue(
          stateOf({ activeFlightSequenceId: 4 }),
        ),
      /flight sequence 4 is the active sequence of main/,
    ));

  it('is refused with on_air while it is published and queued to start', () =>
    refused(
      (f) =>
        f.flights.listFlightSequences.mockResolvedValue([
          sequence,
          {
            ...clocked,
            publishedAt: new Date(Date.now() - hour),
            scheduledAt: new Date(Date.now() + hour),
          },
        ]),
      /flight sequence 5 is published and queued to start at /,
      queuedArgs,
    ));

  it('lists every reason at once', () =>
    refused((f) => {
      f.f.programs.getState.mockResolvedValue(
        stateOf({ activeFlightSequenceId: 4 }),
      );
      f.flights.listFlightSequences.mockResolvedValue([
        { ...sequence, isRunning: true },
      ]);
    }, /is running on main; flight sequence 4 is the active sequence of main/));

  it.each([
    ['a draft clocked log', clocked],
    [
      'a published log that has already started',
      {
        ...clocked,
        publishedAt: new Date(Date.now() - 2 * hour),
        lastStartedAt: new Date(Date.now() - hour),
        scheduledAt: new Date(Date.now() - hour),
      },
    ],
    [
      'a published log whose start was missed long ago',
      {
        ...clocked,
        publishedAt: new Date(Date.now() - 2 * hour),
        scheduledAt: new Date(Date.now() - hour),
      },
    ],
  ])(
    'runs for %s, after the confirm, and says what is lost',
    async (_why, one) => {
      const f = buildFlight();
      f.flights.listFlightSequences.mockResolvedValue([sequence, one]);
      const spec = specNamed(f.specs, NAME);
      const target = { program_id: 'main', sequence_id: 5 };
      const plan = await spec.dryRun!(target, ctx);
      expect(plan.onAir).toBe(false);
      expect(plan.recoverable).toBe(false);
      expect(plan.summary).not.toMatch(/^REFUSED/);
      expect(plan.summary).toMatch(
        /Lost: its cues and their order, its schedule/,
      );
      expect(plan.summary).toMatch(/cannot be recovered/);
      expect(plan.summary).toMatch(/The console deletes it whatever its state/);
      expect(plan.affects).toEqual([
        { kind: 'flight_sequence', id: '5', name: 'Noon block' },
        { kind: 'program', id: 'main', name: 'main' },
      ]);
      await expect(spec.confirmTarget!(target, ctx)).resolves.toEqual({
        id: 'main/5',
        name: 'Noon block',
      });
      await expect(spec.run(target, ctx)).resolves.toMatchObject({
        result: { deletedId: 4 },
        audit: { target: 'main/5' },
      });
      expect(f.flights.deleteFlightSequence).toHaveBeenCalledWith('main', 5);
    },
  );

  it('checks again at run time, so a plan made while idle cannot cut a live sequence', async () => {
    const f = buildFlight();
    const spec = specNamed(f.specs, NAME);
    expect((await spec.dryRun!(args, ctx)).onAir).toBe(false);
    f.flights.listFlightSequences.mockResolvedValue([
      { ...sequence, isRunning: true },
      clocked,
    ]);
    await expect(spec.run(args, ctx)).rejects.toMatchObject({
      code: 'on_air',
    });
    expect(f.flights.deleteFlightSequence).not.toHaveBeenCalled();
  });
});
