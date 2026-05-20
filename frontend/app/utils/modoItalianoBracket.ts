export interface ModoItalianoBracketMatch {
  id: number;
  songAId: number | null;
  songBId: number | null;
  winnerId: number | null;
}

const MATCH_COUNT = 15;

const ADVANCEMENT_TARGETS: Record<number, { matchId: number; slot: 'songAId' | 'songBId' }> = {
  1: { matchId: 9, slot: 'songAId' },
  2: { matchId: 9, slot: 'songBId' },
  3: { matchId: 10, slot: 'songAId' },
  4: { matchId: 10, slot: 'songBId' },
  5: { matchId: 11, slot: 'songAId' },
  6: { matchId: 11, slot: 'songBId' },
  7: { matchId: 12, slot: 'songAId' },
  8: { matchId: 12, slot: 'songBId' },
  9: { matchId: 13, slot: 'songAId' },
  10: { matchId: 13, slot: 'songBId' },
  11: { matchId: 14, slot: 'songAId' },
  12: { matchId: 14, slot: 'songBId' },
  13: { matchId: 15, slot: 'songAId' },
  14: { matchId: 15, slot: 'songBId' }
};

export function createDefaultModoItalianoBracketMatches(): ModoItalianoBracketMatch[] {
  return Array.from({ length: MATCH_COUNT }, (_, index) => ({
    id: index + 1,
    songAId: null,
    songBId: null,
    winnerId: null
  }));
}

export function normalizeModoItalianoBracketMatches(matches: unknown): ModoItalianoBracketMatch[] {
  const safeMatches = createDefaultModoItalianoBracketMatches();

  if (!Array.isArray(matches)) {
    return applyModoItalianoBracketAdvancement(safeMatches);
  }

  matches.forEach((match) => {
    if (!match || typeof match !== 'object') {
      return;
    }

    const record = match as Partial<ModoItalianoBracketMatch>;
    if (typeof record.id !== 'number' || record.id < 1 || record.id > MATCH_COUNT) {
      return;
    }

    safeMatches[record.id - 1] = {
      ...safeMatches[record.id - 1],
      ...record,
      songAId: typeof record.songAId === 'number' ? record.songAId : null,
      songBId: typeof record.songBId === 'number' ? record.songBId : null,
      winnerId: typeof record.winnerId === 'number' ? record.winnerId : null
    };
  });

  return applyModoItalianoBracketAdvancement(safeMatches);
}

export function applyModoItalianoBracketAdvancement(matches: ModoItalianoBracketMatch[]): ModoItalianoBracketMatch[] {
  const nextMatches = matches.map((match) => ({ ...match }));
  const usedOpeningSongs = new Set<number>();

  nextMatches.forEach((match) => {
    if (match.id > 8) {
      match.songAId = null;
      match.songBId = null;
    }
  });

  nextMatches.slice(0, 8).forEach((match) => {
    if (match.songAId !== null && usedOpeningSongs.has(match.songAId)) {
      match.songAId = null;
    }
    if (match.songAId !== null) {
      usedOpeningSongs.add(match.songAId);
    }

    if (match.songBId !== null && usedOpeningSongs.has(match.songBId)) {
      match.songBId = null;
    }
    if (match.songBId !== null) {
      usedOpeningSongs.add(match.songBId);
    }
  });

  nextMatches.forEach((match) => {
    if (match.winnerId !== null && match.winnerId !== match.songAId && match.winnerId !== match.songBId) {
      match.winnerId = null;
    }

    const target = ADVANCEMENT_TARGETS[match.id];
    if (target) {
      nextMatches[target.matchId - 1][target.slot] = match.winnerId;
    }
  });

  return nextMatches;
}
