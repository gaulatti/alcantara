import type { ProgramService } from '../../program/program.service';
import {
  normalizeProgramSongQueue,
  type ProgramSongQueueEntry,
} from '../../radio/song-queue.utils';
import { CATALOG_ITEM_PREFIX } from '../../radio/song-similarity.utils';
import {
  collectProgramSongLeaves,
  findUniqueProgramSongLeafById,
  normalizeProgramSongSequence,
} from '../../radio/song-sequence.utils';

/**
 * What decides whether a song, an image, an asset or a label may be deleted
 * through MCP (gaulatti/alcantara#218): the programs as ProgramService lists
 * them, with their song sequence and queue, their scenes (whose settings may
 * name an asset, a label or an image address) and their media groups.
 */

export interface UsageProgram {
  programId: string;
  activeSceneId: number | null;
  stagedSceneId: number | null;
  fadeToBlack: boolean;
  songSequence: unknown;
  songQueue: unknown;
  scenes: Array<{ sceneId: number; scene: { metadata?: string | null } }>;
  mediaGroups: Array<{
    mediaGroupId: number;
    mediaGroup: { mediaItems?: Array<{ mediaId: number }> };
  }>;
}

export const loadUsage = async (
  programs: ProgramService,
): Promise<UsageProgram[]> =>
  (await programs.listPrograms()) as unknown as UsageProgram[];

const idsWhere = (
  list: UsageProgram[],
  test: (program: UsageProgram) => boolean,
): string[] => list.filter(test).map((program) => program.programId);

/** A scene or fade to black is on air: the program's live page is reading its media. */
export const visuallyOnAir = (program: UsageProgram): boolean =>
  program.activeSceneId !== null || program.fadeToBlack;

/** Programs whose song sequence lists the song. */
export const sequencedIn = (list: UsageProgram[], songId: number): string[] =>
  idsWhere(list, (program) =>
    collectProgramSongLeaves(
      normalizeProgramSongSequence(program.songSequence),
    ).some((leaf) => leaf.songId === songId),
  );

/** Programs whose Play Next queue holds the song (from the sequence or the catalog). */
export const queuedIn = (list: UsageProgram[], songId: number): string[] =>
  idsWhere(list, (program) => {
    const sequence = normalizeProgramSongSequence(program.songSequence);
    const holds = (entry: ProgramSongQueueEntry): boolean =>
      entry.itemId === `${CATALOG_ITEM_PREFIX}${songId}` ||
      findUniqueProgramSongLeafById(sequence, entry.itemId)?.songId === songId;
    return normalizeProgramSongQueue(program.songQueue).some(holds);
  });

/** Programs that are playing the song's audio now. */
export async function playingIn(
  programs: ProgramService,
  list: UsageProgram[],
  audioUrl: string,
): Promise<string[]> {
  const playing: string[] = [];
  for (const program of list) {
    const playback = await programs.getProgramSongPlayback(program.programId);
    if (playback.isPlaying && playback.audioUrl.trim() === audioUrl.trim())
      playing.push(program.programId);
  }
  return playing;
}

/** Programs that read a media group (an assignment to the program). */
export const readingGroup = (
  list: UsageProgram[],
  mediaGroupId: number,
): string[] =>
  idsWhere(list, (program) =>
    program.mediaGroups.some((entry) => entry.mediaGroupId === mediaGroupId),
  );

/** Programs that read a group holding the image, and those among them on air. */
export function readingImage(list: UsageProgram[], mediaId: number) {
  const holds = (program: UsageProgram) =>
    program.mediaGroups.some((entry) =>
      (entry.mediaGroup.mediaItems ?? []).some(
        (item) => item.mediaId === mediaId,
      ),
    );
  return {
    readers: idsWhere(list, holds),
    onAir: idsWhere(
      list,
      (program) => holds(program) && visuallyOnAir(program),
    ),
  };
}

/**
 * Programs with a scene whose settings name one of the needles (an asset id,
 * a label id, a file address), and those among them where that scene is on
 * air or staged.
 */
export function scenesNaming(list: UsageProgram[], needles: string[]) {
  const named = needles.filter((needle) => needle.length > 0);
  const names = (entry: UsageProgram['scenes'][number]): boolean =>
    named.some((needle) => (entry.scene.metadata ?? '').includes(needle));
  return {
    readers: idsWhere(list, (program) => program.scenes.some(names)),
    onAir: idsWhere(list, (program) =>
      program.scenes.some(
        (entry) =>
          names(entry) &&
          (entry.sceneId === program.activeSceneId ||
            entry.sceneId === program.stagedSceneId),
      ),
    ),
  };
}

/** The media group a legacy slideshow label mirrors, if it is one. */
export function legacyGroupOf(labelId: string): number | null {
  const prefix = 'legacy-media-group:';
  if (!labelId.startsWith(prefix)) return null;
  const value = Number(labelId.slice(prefix.length));
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

export const uniq = (...lists: string[][]): string[] => [
  ...new Set(lists.flat()),
];
