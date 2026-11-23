import type { DryRunResult } from '../contract';
import type { ProgramService } from '../../program/program.service';

/**
 * What decides whether a destructive capability may run: the program's live
 * state as the service reports it (scene on air, fade to black, song playing,
 * Play Next queue, flight sequence, scene instant) and which programs show or
 * stage a scene.
 */

export interface Named {
  id: number;
  name: string;
}

export interface ProgramLive {
  programId: string;
  type: string;
  activeSceneId: number | null;
  stagedSceneId: number | null;
  activeFlightSequenceId: number | null;
  /** A scene or fade to black is on air. */
  visuallyOnAir: boolean;
  /** The scene whose background instant is playing, if one is. */
  instantSceneId: number | null;
  scenes: Named[];
  mediaGroups: Named[];
  stingers: Named[];
  flightSequences: number;
  queued: number;
  /** Everything that makes the program live, in words. */
  reasons: string[];
  /** The same, as one sentence. */
  liveText: string;
  /** Changes whenever what is live changes: the confirm name of a program action. */
  stamp: string;
}

interface StateLike {
  programId: string;
  type: string;
  activeSceneId: number | null;
  stagedSceneId: number | null;
  fadeToBlack: boolean;
  songQueue: unknown;
  activeFlightSequenceId: number | null;
  scenes: Array<{ sceneId: number; scene: { name: string } }>;
  mediaGroups: Array<{ mediaGroupId: number; mediaGroup: { name: string } }>;
  stingers: Array<{ stingerId: number; stinger: { name: string } }>;
  flightSequences: unknown[];
}

/** The words of every condition that holds. */
export const reasonsOf = (
  pairs: ReadonlyArray<readonly [boolean, string]>,
): string[] => pairs.filter(([hit]) => hit).map(([, text]) => text);

/** The conditions that hold as one sentence, or null when none does. */
export const whyNot = (
  pairs: ReadonlyArray<readonly [boolean, string]>,
): string | null => {
  const hits = reasonsOf(pairs);
  return hits.length > 0 ? hits.join('; ') : null;
};

export async function loadProgramLive(
  programs: ProgramService,
  programId: string,
): Promise<ProgramLive> {
  const state = (await programs.getState(programId)) as unknown as StateLike;
  const song = await programs.getProgramSongPlayback(programId);
  const instant = await programs.getProgramSceneInstantPlayback(programId);
  const queued = Array.isArray(state.songQueue) ? state.songQueue.length : 0;
  const visuallyOnAir = state.activeSceneId !== null || state.fadeToBlack;
  const reasons = reasonsOf([
    [state.activeSceneId !== null, `scene ${state.activeSceneId} is on air`],
    [state.fadeToBlack, 'fade to black is on'],
    [song.isPlaying, 'a song is playing'],
    [queued > 0, `${queued} song(s) are queued`],
    [state.activeFlightSequenceId !== null, 'a flight sequence is active'],
    [instant.isPlaying, 'a scene instant is playing'],
  ]);
  return {
    programId: state.programId,
    type: state.type,
    activeSceneId: state.activeSceneId,
    stagedSceneId: state.stagedSceneId,
    activeFlightSequenceId: state.activeFlightSequenceId,
    visuallyOnAir,
    instantSceneId: instant.isPlaying ? instant.sceneId : null,
    scenes: state.scenes.map((entry) => ({
      id: entry.sceneId,
      name: entry.scene.name,
    })),
    mediaGroups: state.mediaGroups.map((entry) => ({
      id: entry.mediaGroupId,
      name: entry.mediaGroup.name,
    })),
    stingers: state.stingers.map((entry) => ({
      id: entry.stingerId,
      name: entry.stinger.name,
    })),
    flightSequences: state.flightSequences.length,
    queued,
    reasons,
    liveText: reasons.length > 0 ? reasons.join('; ') : 'nothing is live',
    stamp: `scene:${state.activeSceneId} fade:${Number(state.fadeToBlack)} song:${Number(song.isPlaying)} queue:${queued}`,
  };
}

/** The part of a listed program the usage checks read. */
export interface ListedProgram {
  programId: string;
  activeSceneId: number | null;
  stagedSceneId: number | null;
  fadeToBlack: boolean;
  scenes: Array<{ sceneId: number }>;
  mediaGroups: Array<{ mediaGroupId: number }>;
}

export async function listPrograms(
  programs: ProgramService,
): Promise<ListedProgram[]> {
  return (await programs.listPrograms()) as unknown as ListedProgram[];
}

export const programIdsWhere = (
  list: ListedProgram[],
  test: (program: ListedProgram) => boolean,
): string[] => list.filter(test).map((program) => program.programId);

/** The affected entries of a dry run for a list of program ids. */
export const programsAffected = (ids: string[]): DryRunResult['affects'] =>
  ids.map((id) => ({ kind: 'program', id, name: id }));
