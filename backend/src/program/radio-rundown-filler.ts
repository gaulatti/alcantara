import { BadRequestException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { FlightCue } from './flight.types';
import type { TaggedSong } from './radio-log-generator';

export interface FillerRules {
  labelId: string;
  artistSeparation: number;
}
export function parseFillerRules(value: unknown): FillerRules {
  const rules = value as FillerRules | null;
  if (
    !rules ||
    typeof rules.labelId !== 'string' ||
    !rules.labelId.trim() ||
    !Number.isInteger(rules.artistSeparation) ||
    rules.artistSeparation < 0 ||
    rules.artistSeparation > 20
  )
    throw new BadRequestException(
      'Choose a filler tag and 0-20 intervening songs between the same artist',
    );
  return rules;
}

/** Fill the reviewed content's gaps. Tags are never consulted by live playout. */
export function fillRadioRundown(
  rules: FillerRules,
  input: FlightCue[],
  songs: TaggedSong[],
  previousSongIds: number[],
): { items: FlightCue[]; warnings: string[] } {
  const content = input.filter((cue) => !cue.isFiller);
  if (!content.length)
    throw new BadRequestException('Add timed content before filling gaps');
  const used = new Set(
    content.flatMap((cue) => (cue.songId ? [cue.songId] : [])),
  );
  const lastUse = new Map(previousSongIds.map((id, index) => [id, index]));
  const tagged = songs.filter((song) =>
    song.asset?.labels.some((tag) => tag.labelId === rules.labelId),
  );
  const pool = tagged
    .filter(
      (song) => Number.isFinite(song.durationMs) && (song.durationMs ?? 0) > 0,
    )
    .sort(
      (a, b) =>
        (lastUse.get(a.id) ?? -1) - (lastUse.get(b.id) ?? -1) || a.id - b.id,
    );
  const warnings: string[] = [];
  if (pool.length !== tagged.length)
    warnings.push(
      `${tagged.length - pool.length} tagged songs have no duration and were excluded.`,
    );
  const items: FlightCue[] = [];
  const recent: string[] = [];
  const artist = (song: TaggedSong) => song.artist.trim().toLocaleLowerCase();
  const addSong = (song: TaggedSong, cue: FlightCue) => {
    if (
      rules.artistSeparation &&
      recent.slice(-rules.artistSeparation).includes(artist(song))
    )
      throw new BadRequestException(
        'Content and fillers violate artist separation. Change the tag, content, or separation rule.',
      );
    items.push(cue);
    recent.push(artist(song));
  };
  let cursor = 0;
  for (let index = 0; index < content.length; index++) {
    const cue = content[index];
    if (cue.clockOffsetSeconds !== undefined) {
      const start = cue.clockOffsetSeconds * 1000;
      if (cursor > start)
        throw new BadRequestException(
          `Content at +${cue.clockOffsetSeconds}s overruns its fixed start by ${Math.ceil((cursor - start) / 1000)}s`,
        );
      cursor = start;
    }
    if (cue.kind === 'playSong') {
      const song = songs.find((s) => s.id === cue.songId);
      if (!song || !(song.durationMs && song.durationMs > 0))
        throw new BadRequestException(
          `Content event ${index + 1}: song duration is required to fill gaps`,
        );
      addSong(song, cue);
      cursor += song.durationMs;
    } else if (cue.kind === 'instant') {
      if (!(cue.durationMs && cue.durationMs > 0))
        throw new BadRequestException(
          `Content event ${index + 1}: enter the clip duration before filling gaps`,
        );
      items.push(cue);
      cursor += cue.durationMs;
    } else items.push(cue);
    const next = content[index + 1];
    if (next && next.clockOffsetSeconds === undefined) continue;
    if (!next) continue;
    const boundary = next.clockOffsetSeconds! * 1000;
    if (cursor > boundary)
      throw new BadRequestException(
        `Content overruns the next fixed boundary by ${Math.ceil((cursor - boundary) / 1000)}s. Remove or shorten content before filling.`,
      );
    // An explicit stop is intentional silence, never implicitly replaced by music.
    if (cue.kind === 'stopSong') {
      cursor = boundary;
      continue;
    }
    while (cursor < boundary) {
      const remaining = boundary - cursor;
      const eligible = pool.filter(
        (song) =>
          !used.has(song.id) &&
          (!rules.artistSeparation ||
            !recent.slice(-rules.artistSeparation).includes(artist(song))),
      );
      const song =
        eligible.find((song) => song.durationMs! <= remaining) ??
        [...eligible].sort(
          (a, b) => a.durationMs! - b.durationMs! || a.id - b.id,
        )[0];
      if (!song)
        throw new BadRequestException(
          `Not enough eligible filler songs to cover ${Math.ceil(remaining / 1000)}s. Change the tag or artist separation.`,
        );
      used.add(song.id);
      addSong(song, {
        id: randomUUID(),
        kind: 'playSong',
        songId: song.id,
        isFiller: true,
      });
      if (song.durationMs! > remaining)
        warnings.push(
          `Filler ${song.title ?? `song #${song.id}`} will be cut ${Math.ceil((song.durationMs! - remaining) / 1000)}s before its end at the fixed boundary.`,
        );
      cursor = Math.min(boundary, cursor + song.durationMs!);
      if (items.length >= 120)
        throw new BadRequestException(
          'A filled rundown can contain at most 120 events including its end boundary',
        );
    }
  }
  if (items.length > 120)
    throw new BadRequestException(
      'A filled rundown can contain at most 120 events',
    );
  return { items, warnings };
}
