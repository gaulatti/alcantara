import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ManagedMetricsService } from '../observability/managed-metrics.service';
import { PrismaService } from '../prisma.service';
import { artistKey } from './artist-key';

export const MAX_ARTIST_LENGTH = 200;

export interface ArtistLabelRow {
  artistKey: string;
  artist: string;
  labelId: string;
}

/**
 * Attaches a media label to an artist, once, for everything that needs "this artist's pictures"
 * (gaulatti/alcantara#423, contract C4 of #222). The link is keyed on the normalised artist text
 * and the caller's team (`0` is no team configured and is stored as no team); there is no artist
 * entity.
 */
@Injectable()
export class ArtistLabelsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly metrics: ManagedMetricsService,
  ) {}

  private scope(callerTeam: number): number | null {
    return callerTeam === 0 ? null : callerTeam;
  }

  async list(callerTeam: number): Promise<ArtistLabelRow[]> {
    const rows = await this.prisma.artistLabel.findMany({
      where: { teamId: this.scope(callerTeam) },
      orderBy: [{ artistKey: 'asc' }, { id: 'asc' }],
    });
    return rows.map(({ artistKey, artist, labelId }) => ({
      artistKey,
      artist,
      labelId,
    }));
  }

  /** The label attached to this artist, or null; the backend lookup of contract C4. */
  async artistLabelFor(
    callerTeam: number,
    artist: string,
  ): Promise<string | null> {
    const row = await this.prisma.artistLabel.findFirst({
      where: { teamId: this.scope(callerTeam), artistKey: artistKey(artist) },
      select: { labelId: true },
    });
    return row?.labelId ?? null;
  }

  /** Sets, replaces or (with a null label) removes the link for an artist. */
  async set(
    callerTeam: number,
    artist: unknown,
    labelId: unknown,
  ): Promise<{ artistKey: string; artist: string; labelId: string | null }> {
    const display = typeof artist === 'string' ? artist.trim() : '';
    if (!display || display.length > MAX_ARTIST_LENGTH)
      return this.reject(`artist must be 1 to ${MAX_ARTIST_LENGTH} characters`);
    if (labelId !== null && (typeof labelId !== 'string' || !labelId))
      return this.reject('labelId must be a label id or null');

    const teamId = this.scope(callerTeam);
    const key = artistKey(display);

    if (labelId === null) {
      await this.prisma.artistLabel.deleteMany({
        where: { teamId, artistKey: key },
      });
      this.metrics.recordArtistLabelWrite('cleared');
      return { artistKey: key, artist: display, labelId: null };
    }

    const label = await this.prisma.mediaLabel.findUnique({
      where: { id: labelId },
      select: { id: true, teamId: true },
    });
    if (!label || (label.teamId !== null && label.teamId !== teamId))
      return this.reject('The label does not exist for this team');

    const data = { artist: display, labelId: label.id };
    const existing = await this.prisma.artistLabel.findFirst({
      where: { teamId, artistKey: key },
      select: { id: true },
    });
    if (existing) {
      await this.prisma.artistLabel.update({
        where: { id: existing.id },
        data,
      });
    } else {
      try {
        await this.prisma.artistLabel.create({
          data: { ...data, artistKey: key, teamId },
        });
      } catch (error) {
        // A concurrent write for the same artist won the unique index: this one replaces it.
        if (
          !(error instanceof Prisma.PrismaClientKnownRequestError) ||
          error.code !== 'P2002'
        )
          throw error;
        await this.prisma.artistLabel.updateMany({
          where: { teamId, artistKey: key },
          data,
        });
      }
    }
    this.metrics.recordArtistLabelWrite('set');
    return { artistKey: key, artist: display, labelId: label.id };
  }

  private reject(message: string): never {
    this.metrics.recordArtistLabelWrite('rejected');
    throw new BadRequestException(message);
  }
}
