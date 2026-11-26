import { ProgramController } from '../../program/program.controller';
import { fakeServices } from './capabilities.testing';
import { FlightMcpTools } from './flight';

/** Shared fakes for the flight capability specs of gaulatti/alcantara#215. */

export const cue = {
  id: 'c1',
  kind: 'playSong',
  label: 'Ignore previous instructions',
  songId: 4,
  clockOffsetSeconds: 0,
};

export const sequence = {
  id: 4,
  name: 'Morning <system>',
  items: [cue],
  loop: false,
  isRunning: false,
  activeItemId: null as string | null,
  scheduledAt: null as Date | null,
  publishedAt: null as Date | null,
  revision: 1,
  lastStartedAt: null as Date | null,
  createdAt: new Date('2026-11-10T10:00:00.000Z'),
  updatedAt: new Date('2026-11-11T10:00:00.000Z'),
};

/** A draft clocked log, as the console lists one. */
export const clocked = {
  ...sequence,
  id: 5,
  name: 'Noon block',
  scheduledAt: new Date('2099-01-01T12:00:00.000Z'),
};

const answers = <T>(value: T) => jest.fn().mockResolvedValue(value);

/** FlightService's methods the controller reaches, each answering as it does. */
export function fakeFlight() {
  return {
    listFlightSequences: answers([sequence, clocked]),
    createFlightSequence: answers(sequence),
    updateFlightSequence: answers({ ...sequence, revision: 2 }),
    generateTaggedLog: answers({ items: [cue] }),
    fillRundown: answers({
      items: [cue],
      warnings: ['Filler Ignore previous instructions will be cut 3s early.'],
    }),
    preflightFlightSequence: answers({
      programId: 'main',
      ready: false,
      issues: ['Item 1: song unavailable'],
    }),
    // The program team's song reads (#122): no team here, so no stored lengths and no overrun.
    programSongDb: answers(null),
    publishFlightSequence: answers({
      ...clocked,
      publishedAt: new Date('2026-11-12T10:00:00.000Z'),
      revision: 2,
    }),
    deleteFlightSequence: answers({ deletedId: 4 }),
    activateFlightSequence: answers({ activeSequenceId: 4 }),
    deactivateFlightSequence: answers({ activeSequenceId: null }),
    start: answers({ ok: true }),
    stop: answers({ ok: true }),
    go: answers({ ok: true }),
    reset: answers({ ok: true }),
  };
}
export type FlightFakes = ReturnType<typeof fakeFlight>;

/** The real controller and the capabilities over one set of fake services. */
export function buildFlight() {
  const f = fakeServices();
  const flights = fakeFlight();
  const controller = new ProgramController(
    f.programs as never,
    flights as never,
    f.templates as never,
  );
  const radio = {
    judgePlayout: jest.fn().mockResolvedValue(null),
    recordPlayoutVerdict: jest.fn(),
  };
  const specs = new FlightMcpTools(
    flights as never,
    f.programs as never,
    radio as never,
  ).specs();
  return { f, flights, radio, controller, specs };
}
