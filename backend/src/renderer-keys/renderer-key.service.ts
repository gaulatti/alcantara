import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { PrismaService } from '../prisma.service';

/** A program's renderer key as it may be shown: never the key, never its hash. */
export interface RendererKeyMetadata {
  programId: string;
  exists: boolean;
  version: number | null;
  createdAt: string | null;
  rotatedAt: string | null;
  lastUsedAt: string | null;
}

/** Whose a presented key is, for the program a request names. */
export type RendererKeyMatch = 'program' | 'other-program' | 'none';

/** A used key's last-used time is written at most this often per program, so polling callers do not write each call. */
export const LAST_USED_WRITE_MS = 60_000;

const KEY_PREFIX = 'alrk_';

export function hashRendererKey(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex');
}

const iso = (value: Date | null | undefined) =>
  value ? value.toISOString() : null;

/**
 * One renderer key per program (gaulatti/alcantara#884). A key is 32 random bytes; only its SHA-256 is stored, so a
 * key can be checked but never read back. The clear key exists once, in the answer to the rotation that made it.
 */
@Injectable()
export class RendererKeyService {
  private readonly logger = new Logger(RendererKeyService.name);
  private readonly lastUsedWrites = new Map<number, number>();

  constructor(private readonly prisma: PrismaService) {}

  /** The clock; tests replace it. */
  now: () => number = Date.now;

  async metadata(programId: string): Promise<RendererKeyMetadata> {
    const program = await this.program(programId);
    const key = await this.prisma.programRendererKey.findUnique({
      where: { programStateId: program.id },
    });
    return {
      programId,
      exists: key !== null,
      version: key?.version ?? null,
      createdAt: iso(key?.createdAt),
      rotatedAt: iso(key?.rotatedAt),
      lastUsedAt: iso(key?.lastUsedAt),
    };
  }

  /**
   * Issues the program's key, or replaces it: the previous key stops working at once. Returns the clear key, which is
   * never stored or shown again, with the metadata after the change and the version before it (null when new).
   */
  async rotate(programId: string): Promise<{
    key: string;
    metadata: RendererKeyMetadata;
    previousVersion: number | null;
  }> {
    const program = await this.program(programId);
    const key = `${KEY_PREFIX}${randomBytes(32).toString('base64url')}`;
    const keyHash = hashRendererKey(key);
    const previous = await this.prisma.programRendererKey.findUnique({
      where: { programStateId: program.id },
    });
    const now = new Date(this.now());
    const saved = await this.prisma.programRendererKey.upsert({
      where: { programStateId: program.id },
      create: {
        programStateId: program.id,
        keyHash,
        version: 1,
        createdAt: now,
        rotatedAt: now,
      },
      update: {
        keyHash,
        version: { increment: 1 },
        rotatedAt: now,
        lastUsedAt: null,
      },
    });
    this.lastUsedWrites.delete(program.id);
    return {
      key,
      previousVersion: previous?.version ?? null,
      metadata: {
        programId,
        exists: true,
        version: saved.version,
        createdAt: iso(saved.createdAt),
        rotatedAt: iso(saved.rotatedAt),
        lastUsedAt: iso(saved.lastUsedAt),
      },
    };
  }

  /**
   * Whose a presented key is: this program's, another program's, or nobody's. A match records the key's last use, at
   * most once a minute per program.
   */
  async match(
    presented: string | undefined,
    programId: string,
  ): Promise<RendererKeyMatch> {
    if (!presented) return 'none';
    const key = await this.prisma.programRendererKey.findUnique({
      where: { keyHash: hashRendererKey(presented) },
      include: { programState: { select: { programId: true } } },
    });
    if (!key) return 'none';
    if (key.programState.programId !== programId) return 'other-program';
    await this.touch(key.programStateId);
    return 'program';
  }

  private async touch(programStateId: number): Promise<void> {
    const now = this.now();
    const last = this.lastUsedWrites.get(programStateId);
    if (last !== undefined && now - last < LAST_USED_WRITE_MS) return;
    this.lastUsedWrites.set(programStateId, now);
    // The last-used time is for operators to read; a failed write never fails the caller's request.
    try {
      await this.prisma.programRendererKey.update({
        where: { programStateId },
        data: { lastUsedAt: new Date(now) },
      });
    } catch (error) {
      this.logger.warn(
        `Renderer key last use was not recorded: ${error instanceof Error ? error.name : 'unknown'}`,
      );
    }
  }

  private async program(programId: string): Promise<{ id: number }> {
    const program = await this.prisma.programState.findUnique({
      where: { programId },
      select: { id: true },
    });
    if (!program) throw new NotFoundException('Program not found');
    return program;
  }
}
