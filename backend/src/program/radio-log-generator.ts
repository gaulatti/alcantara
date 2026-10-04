import { BadRequestException } from '@nestjs/common';
import type { FlightCue } from './flight.types';
import { randomUUID } from 'node:crypto';

export interface RadioClockSlot {
  labelId: string;
  count: number;
  clockOffsetSeconds?: number;
}
export interface RadioLogRules {
  slots: RadioClockSlot[];
  artistSeparation: number;
}
export interface TaggedSong {
  title?: string;
  id: number;
  artist: string;
  durationMs: number | null;
  asset: { labels: { labelId: string; position: number }[] } | null;
}

export function parseRadioLogRules(value: unknown): RadioLogRules {
  const rules = value as RadioLogRules | null;
  if (
    !rules ||
    !Array.isArray(rules.slots) ||
    !rules.slots.length ||
    rules.slots.length > 120
  )
    throw new BadRequestException('Choose 1-120 tagged music blocks');
  if (
    !Number.isInteger(rules.artistSeparation) ||
    rules.artistSeparation < 0 ||
    rules.artistSeparation > 20
  )
    throw new BadRequestException(
      'Artist separation must be 0-20 intervening songs',
    );
  let count = 0;
  let fixed = -1;
  for (const [index, slot] of rules.slots.entries()) {
    if (
      !slot ||
      typeof slot.labelId !== 'string' ||
      !slot.labelId.trim() ||
      !Number.isInteger(slot.count) ||
      slot.count < 1 ||
      slot.count > 120
    )
      throw new BadRequestException(
        `Block ${index + 1}: choose a tag and 1-120 songs`,
      );
    count += slot.count;
    if (slot.clockOffsetSeconds !== undefined) {
      if (
        !Number.isInteger(slot.clockOffsetSeconds) ||
        slot.clockOffsetSeconds < 0 ||
        slot.clockOffsetSeconds >= 3600 ||
        slot.clockOffsetSeconds < fixed
      )
        throw new BadRequestException(
          'Fixed starts must increase within the hour',
        );
      fixed = slot.clockOffsetSeconds;
    }
  }
  if (count > 120)
    throw new BadRequestException('A log can contain at most 120 songs');
  if (rules.slots[0].clockOffsetSeconds !== 0)
    throw new BadRequestException('The first block must start at zero');
  return rules;
}

/** Resolve tag membership once. Persisted cues never query tags during playout. */
export function generateRadioLog(
  rules: RadioLogRules,
  songs: TaggedSong[],
  labels: { id: string; name: string }[],
  previousSongIds: number[],
): FlightCue[] {
  const selected: TaggedSong[] = [];
  const used = new Set<number>();
  const items: FlightCue[] = [];
  const lastUse = new Map(previousSongIds.map((id, index) => [id, index]));
  for (const [blockIndex, slot] of rules.slots.entries()) {
    const label = labels.find((candidate) => candidate.id === slot.labelId);
    if (!label)
      throw new BadRequestException(
        `Block ${blockIndex + 1}: tag no longer exists`,
      );
    const pool = songs
      .filter((song) =>
        song.asset?.labels.some(
          (membership) => membership.labelId === slot.labelId,
        ),
      )
      .sort(
        (left, right) =>
          (lastUse.get(left.id) ?? -1) - (lastUse.get(right.id) ?? -1) ||
          left.asset!.labels.find((tag) => tag.labelId === slot.labelId)!
            .position -
            right.asset!.labels.find((tag) => tag.labelId === slot.labelId)!
              .position ||
          left.id - right.id,
      );
    for (let index = 0; index < slot.count; index++) {
      const recentArtists = new Set(
        rules.artistSeparation === 0
          ? []
          : selected
              .slice(-rules.artistSeparation)
              .map((song) => song.artist.trim().toLocaleLowerCase()),
      );
      const song = pool.find(
        (candidate) =>
          !used.has(candidate.id) &&
          !recentArtists.has(candidate.artist.trim().toLocaleLowerCase()),
      );
      if (!song)
        throw new BadRequestException(
          `Block ${blockIndex + 1} (${label.name}): not enough eligible songs for the count and artist separation. Change the tag, count, or rule.`,
        );
      used.add(song.id);
      selected.push(song);
      items.push({
        id: randomUUID(),
        kind: 'playSong',
        songId: song.id,
        ...(index === 0 && slot.clockOffsetSeconds !== undefined
          ? { clockOffsetSeconds: slot.clockOffsetSeconds }
          : {}),
      });
    }
  }
  return items;
}
