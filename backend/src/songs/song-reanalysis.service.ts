import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';
import { ProgramService } from '../program/program.service';
import { PrismaService } from '../prisma.service';

/** The most songs one re-analysis request may name: the rollout of a new cue rule is paced in small batches. */
export const MAX_REANALYSIS_BATCH = 25;

/**
 * Queues songs for a new audio analysis (gaulatti/alcantara#235). A song that is on air, that is playing on a program
 * or announced there as the next song, is refused: its analysis would take its cue points away for the seconds it runs.
 */
@Injectable()
export class SongReanalysisService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly programs: ProgramService,
  ) {}

  /** Validates the ids: 1 to MAX_REANALYSIS_BATCH distinct song ids. */
  ids(songIds: unknown): number[] {
    if (
      !Array.isArray(songIds) ||
      songIds.length < 1 ||
      songIds.length > MAX_REANALYSIS_BATCH ||
      songIds.some((id) => !Number.isInteger(id) || id <= 0) ||
      new Set(songIds).size !== songIds.length
    ) {
      throw new BadRequestException(
        `songIds must be 1 to ${MAX_REANALYSIS_BATCH} distinct song ids`,
      );
    }
    return songIds as number[];
  }

  /** For each named song that exists, the programs it is on air in (empty when it is not on air). */
  async onAir(songIds: unknown): Promise<Map<number, string[]>> {
    const ids = this.ids(songIds);
    const songs = await this.prisma.song.findMany({
      where: { id: { in: ids } },
      select: { id: true, audioUrl: true },
    });
    return this.programs.programsHoldingSongs(songs);
  }

  /**
   * Makes the finished analyses of the named songs due now; they keep their cue points until the new result replaces
   * them. Refused with 409 `on_air` (listing each song and its programs) when any named song is on air, checked here
   * again at queue time so a stale plan cannot take a live song's cues away. Songs that are not found or have no
   * finished analysis are listed, not queued.
   */
  async request(songIds: unknown, now = new Date()) {
    const ids = this.ids(songIds);
    const holding = [...(await this.onAir(ids))].filter(
      ([, programs]) => programs.length > 0,
    );
    if (holding.length > 0) {
      throw new ConflictException({
        code: 'on_air',
        message: `songs on air cannot be analysed again: ${holding
          .map(([id, programs]) => `${id} (${programs.join(', ')})`)
          .join('; ')}`,
        songs: Object.fromEntries(holding),
      });
    }
    const rows = await this.prisma.mediaAssetAnalysis.findMany({
      where: {
        assetId: { in: ids.map((id) => `song:${id}`) },
        status: 'success',
      },
      select: { assetId: true },
    });
    const queued = new Set(rows.map((row) => row.assetId));
    const { count } = await this.prisma.mediaAssetAnalysis.updateMany({
      where: { assetId: { in: [...queued] }, status: 'success' },
      data: { nextAttemptAt: now },
    });
    return {
      requested: count,
      skipped: ids.filter((id) => !queued.has(`song:${id}`)),
    };
  }
}
