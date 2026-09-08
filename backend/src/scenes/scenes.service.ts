import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { ProgramService } from '../program/program.service';

@Injectable()
export class ScenesService {
  private readonly modoItalianoBracketDraws = new Map<number, { timer: NodeJS.Timeout; drawId: number }>();
  constructor(
    private prisma: PrismaService,
    private programService: ProgramService,
  ) {}

  async findAll() {
    return this.prisma.scene.findMany({
      include: { layout: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findOne(id: number) {
    return this.prisma.scene.findUnique({
      where: { id },
      include: { layout: true },
    });
  }

  async create(data: {
    name: string;
    layoutId: number;
    chyronText?: string;
    metadata?: any;
    externalSourceId?: string;
  }) {
    await this.validateExternalSourceReference(data.layoutId, data.externalSourceId, data.metadata);
    const scene = await this.prisma.scene.create({
      data: {
        name: data.name,
        layoutId: data.layoutId,
        chyronText: data.chyronText,
        metadata: data.metadata ? JSON.stringify(data.metadata) : null,
        externalSourceId: data.externalSourceId ?? null,
      },
      include: { layout: true },
    });
    return scene;
  }

  async update(
    id: number,
    data: {
      name?: string;
      layoutId?: number;
      chyronText?: string;
      metadata?: any;
      externalSourceId?: string | null;
    },
  ) {
    const updateData: any = {};
    if (data.name !== undefined) updateData.name = data.name;
    if (data.layoutId !== undefined) updateData.layoutId = data.layoutId;
    if (data.chyronText !== undefined) updateData.chyronText = data.chyronText;
    if (data.metadata !== undefined)
      updateData.metadata = JSON.stringify(data.metadata);
    if (data.externalSourceId !== undefined) updateData.externalSourceId = data.externalSourceId;
    const existing = await this.prisma.scene.findUnique({ where: { id } });
    if (!existing) throw new BadRequestException('Scene not found');
    await this.validateExternalSourceReference(data.layoutId ?? existing.layoutId, data.externalSourceId === undefined ? existing.externalSourceId ?? undefined : data.externalSourceId ?? undefined, data.metadata);

    this.cancelModoItalianoBracketDraw(id);
    const scene = await this.prisma.scene.update({
      where: { id },
      data: updateData,
      include: { layout: true },
    });

    const programIds =
      await this.programService.getProgramIdsByAssignedScene(id);
    for (const programId of programIds) {
      this.programService.broadcastUpdate(programId, {
        type: 'scene_update',
        programId,
        scene,
      });
    }

    return scene;
  }

  async updateChyron(id: number, chyronText: string) {
    const scene = await this.prisma.scene.update({
      where: { id },
      data: { chyronText },
      include: { layout: true },
    });

    const programIds = await this.programService.getProgramIdsByActiveScene(id);
    for (const programId of programIds) {
      this.programService.broadcastUpdate(programId, {
        type: 'chyron_update',
        scene,
      });
    }

    return scene;
  }

  async drawModoItalianoBracket(id: number, data: { componentType?: string; seed?: number }) {
    const componentType = data.componentType === 'modoitaliano-bracket' ? data.componentType : 'modoitaliano-bracket';
    const scene = await this.findOne(id);
    if (!scene) {
      throw new BadRequestException('Scene not found');
    }

    const metadata = this.parseMetadata(scene.metadata);
    const bracket = metadata[componentType] && typeof metadata[componentType] === 'object' ? metadata[componentType] as Record<string, unknown> : {};
    if (bracket.startRound !== 'quarterfinals') {
      throw new BadRequestException('Bracket draw is only available for quarterfinal brackets');
    }

    const matches = this.normalizeBracketMatches(bracket.matches);
    const openingSlots = [9, 10, 11, 12].flatMap((matchId) => [
      { matchId, field: 'songAId' as const },
      { matchId, field: 'songBId' as const },
    ]);
    const usedSongIds = new Set<number>();
    openingSlots.forEach(({ matchId, field }) => {
      const songId = matches[matchId - 1][field];
      if (songId !== null) usedSongIds.add(songId);
    });
    const nextSlot = openingSlots.find(({ matchId, field }) => matches[matchId - 1][field] === null);
    const poolIds = this.normalizeSongIds(bracket.randomSongPoolIds).filter((songId) => !usedSongIds.has(songId));
    if (!nextSlot || poolIds.length === 0) {
      throw new BadRequestException('No available songs or bracket slots remain for this draw');
    }

    const now = Date.now();
    const seed = Number.isFinite(Number(data.seed)) ? Math.floor(Number(data.seed)) : now;
    const shuffledSongIds = this.seededShuffle(poolIds, seed);
    const durationSeconds = this.normalizeDrawDuration(bracket.drawDurationSeconds, bracket.drawSeed);
    this.cancelModoItalianoBracketDraw(id);
    const programIds = await this.programService.getProgramIdsByAssignedScene(id);
    for (const programId of programIds) {
      this.programService.broadcastUpdate(programId, {
        type: 'modoitaliano_bracket_draw_start',
        sceneId: id,
        componentType,
        drawId: now,
        durationSeconds,
        songIds: shuffledSongIds,
      });
    }

    const timer = setTimeout(() => {
      void this.completeModoItalianoBracketDraw(id, componentType, now, shuffledSongIds[0]);
    }, durationSeconds * 1000);
    this.modoItalianoBracketDraws.set(id, { timer, drawId: now });
    return { drawId: now, durationSeconds, sceneId: id };
  }

  async voteModoItalianoBracket(id: number, data: { componentType?: string; matchId?: number; voterId?: string; songId?: number | null }) {
    const componentType = data.componentType === 'modoitaliano-bracket' ? data.componentType : 'modoitaliano-bracket';
    const matchId = Number(data.matchId);
    const voterId = typeof data.voterId === 'string' ? data.voterId.trim() : '';
    if (!Number.isInteger(matchId) || matchId < 1 || matchId > 15 || !voterId) throw new BadRequestException('Invalid vote');
    const scene = await this.findOne(id);
    if (!scene) throw new BadRequestException('Scene not found');
    const metadata = this.parseMetadata(scene.metadata);
    const bracket = metadata[componentType] && typeof metadata[componentType] === 'object' ? metadata[componentType] as Record<string, unknown> : {};
    const voters = Array.isArray(bracket.voters) ? bracket.voters.filter((voter): voter is { id: string; name: string } => Boolean(voter && typeof voter === 'object' && typeof (voter as any).id === 'string' && typeof (voter as any).name === 'string')) : [];
    if (!voters.some((voter) => voter.id === voterId)) throw new BadRequestException('Unknown voter');
    const matches = this.normalizeBracketMatches(bracket.matches);
    const match = matches[matchId - 1];
    const songId = data.songId === null ? null : Number(data.songId);
    if (songId !== null && songId !== match.songAId && songId !== match.songBId) throw new BadRequestException('Vote must be for a song in this match');
    const matchVotes = bracket.matchVotes && typeof bracket.matchVotes === 'object' ? { ...(bracket.matchVotes as Record<string, Record<string, number | null>>) } : {};
    matchVotes[String(matchId)] = { ...(matchVotes[String(matchId)] ?? {}), [voterId]: songId };
    const requiredVotes = Math.floor(voters.length / 2) + 1;
    const counts = voters.reduce<Record<number, number>>((result, voter) => {
      const vote = matchVotes[String(matchId)]?.[voter.id];
      if (typeof vote === 'number' && (vote === match.songAId || vote === match.songBId)) result[vote] = (result[vote] ?? 0) + 1;
      return result;
    }, {});
    const winnerId = [match.songAId, match.songBId].find((candidate) => candidate !== null && (counts[candidate] ?? 0) >= requiredVotes) ?? null;
    const nextBracket: Record<string, unknown> = { ...bracket, matchVotes, activeVotingMatchId: matchId, votingWinnerId: null, votingResultStartedAt: null, matches };
    if (winnerId !== null) {
      match.winnerId = winnerId;
      const target = ({ 1: [9, 'songAId'], 2: [9, 'songBId'], 3: [10, 'songAId'], 4: [10, 'songBId'], 5: [11, 'songAId'], 6: [11, 'songBId'], 7: [12, 'songAId'], 8: [12, 'songBId'], 9: [13, 'songAId'], 10: [13, 'songBId'], 11: [14, 'songAId'], 12: [14, 'songBId'], 13: [15, 'songAId'], 14: [15, 'songBId'] } as Record<number, [number, 'songAId' | 'songBId']>)[matchId];
      if (target) matches[target[0] - 1][target[1]] = winnerId;
      nextBracket.votingWinnerId = winnerId;
      nextBracket.votingResultStartedAt = Date.now();
    }
    return this.persistSceneMetadata(id, { ...metadata, [componentType]: nextBracket });
  }

  async openModoItalianoBracketVoting(id: number, data: { componentType?: string; matchId?: number }) {
    const componentType = data.componentType === 'modoitaliano-bracket' ? data.componentType : 'modoitaliano-bracket';
    const matchId = Number(data.matchId);
    if (!Number.isInteger(matchId) || matchId < 1 || matchId > 15) throw new BadRequestException('Invalid match');
    const scene = await this.findOne(id);
    if (!scene) throw new BadRequestException('Scene not found');
    const metadata = this.parseMetadata(scene.metadata);
    const bracket = metadata[componentType] && typeof metadata[componentType] === 'object' ? metadata[componentType] as Record<string, unknown> : {};
    const match = this.normalizeBracketMatches(bracket.matches)[matchId - 1];
    if (match.songAId === null || match.songBId === null || match.winnerId !== null) throw new BadRequestException('This match is not open for voting');
    return this.persistSceneMetadata(id, {
      ...metadata,
      [componentType]: {
        ...bracket,
        activeVotingMatchId: matchId,
        votingWinnerId: null,
        votingResultStartedAt: null,
      },
    });
  }

  private async completeModoItalianoBracketDraw(sceneId: number, componentType: string, drawId: number, selectedSongId: number) {
    const activeDraw = this.modoItalianoBracketDraws.get(sceneId);
    if (!activeDraw || activeDraw.drawId !== drawId) return;
    this.modoItalianoBracketDraws.delete(sceneId);
    const scene = await this.findOne(sceneId);
    if (!scene) return;
    const metadata = this.parseMetadata(scene.metadata);
    const bracket = metadata[componentType] && typeof metadata[componentType] === 'object' ? metadata[componentType] as Record<string, unknown> : {};
    const matches = this.normalizeBracketMatches(bracket.matches);
    const nextSlot = [9, 10, 11, 12]
      .flatMap((matchId) => [{ matchId, field: 'songAId' as const }, { matchId, field: 'songBId' as const }])
      .find(({ matchId, field }) => matches[matchId - 1][field] === null);
    if (!nextSlot) return;
    matches[nextSlot.matchId - 1][nextSlot.field] = selectedSongId;
    await this.persistSceneMetadata(sceneId, {
      ...metadata,
      [componentType]: { ...bracket, matches },
    });
    const programIds = await this.programService.getProgramIdsByAssignedScene(sceneId);
    for (const programId of programIds) {
      this.programService.broadcastUpdate(programId, { type: 'modoitaliano_bracket_draw_end', sceneId, componentType, drawId });
    }
  }

  private cancelModoItalianoBracketDraw(sceneId: number) {
    const activeDraw = this.modoItalianoBracketDraws.get(sceneId);
    if (!activeDraw) return;
    clearTimeout(activeDraw.timer);
    this.modoItalianoBracketDraws.delete(sceneId);
  }

  private async persistSceneMetadata(id: number, metadata: Record<string, unknown>) {
    const scene = await this.prisma.scene.update({ where: { id }, data: { metadata: JSON.stringify(metadata) }, include: { layout: true } });
    const programIds = await this.programService.getProgramIdsByAssignedScene(id);
    for (const programId of programIds) this.programService.broadcastUpdate(programId, { type: 'scene_update', programId, scene });
    return scene;
  }

  private parseMetadata(metadata: unknown): Record<string, unknown> {
    if (typeof metadata !== 'string') return {};
    try {
      const parsed = JSON.parse(metadata);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
    } catch {
      return {};
    }
  }

  private normalizeSongIds(value: unknown): number[] {
    if (!Array.isArray(value)) return [];
    return [...new Set(value.map(Number).filter((id) => Number.isInteger(id) && id > 0))];
  }

  private normalizeBracketMatches(value: unknown) {
    const matches = Array.from({ length: 15 }, (_, index) => ({ id: index + 1, songAId: null as number | null, songBId: null as number | null, winnerId: null as number | null }));
    if (!Array.isArray(value)) return matches;
    value.forEach((entry) => {
      if (!entry || typeof entry !== 'object') return;
      const match = entry as Record<string, unknown>;
      const id = Number(match.id);
      if (!Number.isInteger(id) || id < 1 || id > matches.length) return;
      matches[id - 1] = {
        id,
        songAId: Number.isInteger(match.songAId) ? Number(match.songAId) : null,
        songBId: Number.isInteger(match.songBId) ? Number(match.songBId) : null,
        winnerId: Number.isInteger(match.winnerId) ? Number(match.winnerId) : null,
      };
    });
    return matches;
  }

  private normalizeDrawDuration(value: unknown, fallback: unknown): number {
    const duration = Number(value);
    const fallbackDuration = Number(fallback);
    return Number.isFinite(duration) && duration > 0 ? Math.floor(duration) : Number.isFinite(fallbackDuration) && fallbackDuration > 0 ? Math.floor(fallbackDuration) : 5;
  }

  private async validateExternalSourceReference(layoutId: number, sourceId: string | undefined, metadata: unknown) {
    const layout = await this.prisma.layout.findUnique({ where: { id: layoutId }, select: { componentType: true } });
    if (!layout) throw new BadRequestException('Layout not found');
    if (layout.componentType !== 'video-stream') return;
    if (containsSourceUrl(metadata)) throw new BadRequestException('Video stream scenes reference externalSourceId, not a URL');
    if (!sourceId) throw new BadRequestException('Video stream scenes require externalSourceId');
    const source = await this.prisma.externalSource.findFirst({ where: { id: sourceId, revokedAt: null }, select: { id: true } });
    if (!source) throw new BadRequestException('External source not found');
  }

  private seededShuffle(ids: number[], seed: number): number[] {
    let state = seed >>> 0;
    const random = () => {
      state += 0x6d2b79f5;
      let value = state;
      value = Math.imul(value ^ (value >>> 15), value | 1);
      value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
      return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
    };
    const shuffled = [...ids];
    for (let index = shuffled.length - 1; index > 0; index -= 1) {
      const swapIndex = Math.floor(random() * (index + 1));
      [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
    }
    return shuffled;
  }

  async remove(id: number) {
    const assignedProgramIds =
      await this.programService.getProgramIdsByAssignedScene(id);
    const clearedProgramIds = await this.programService.clearActiveScene(id);
    for (const programId of clearedProgramIds) {
      this.programService.broadcastUpdate(programId, {
        type: 'scene_cleared',
      });
    }

    const deleted = await this.prisma.scene.delete({
      where: { id },
    });

    for (const programId of assignedProgramIds) {
      const state = await this.programService.getState(programId);
      this.programService.broadcastUpdate(programId, {
        type: 'program_scenes_changed',
        state,
      });
    }

    return deleted;
  }
}

function containsSourceUrl(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(containsSourceUrl);
  return Object.entries(value).some(([key, nested]) => key === 'sourceUrl' || containsSourceUrl(nested));
}
