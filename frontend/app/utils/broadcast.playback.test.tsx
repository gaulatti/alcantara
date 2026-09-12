import { expect, it } from "vitest";
import {
  normalizeProgramSongPlayback,
  reconcileProgramSongOffAir,
} from "./broadcast";

it("preserves authoritative playback identity, metadata, and freshness", () => {
  expect(
    normalizeProgramSongPlayback({
      token: "song-1:audio",
      audioUrl: "https://example.test/song.mp3",
      title: "Song one",
      artist: "Artist one",
      coverUrl: "https://example.test/cover.jpg",
      progress: 0.5,
      currentTimeMs: 30_000,
      durationMs: 60_000,
      isPlaying: true,
      startedAt: "2026-09-11T12:00:00.000Z",
      updatedAt: "2026-09-11T12:00:30.000Z",
      telemetryStale: true,
    }),
  ).toMatchObject({
    token: "song-1:audio",
    title: "Song one",
    artist: "Artist one",
    coverUrl: "https://example.test/cover.jpg",
    currentTimeMs: 30_000,
    isPlaying: true,
    startedAt: "2026-09-11T12:00:00.000Z",
    telemetryStale: true,
  });
});

it("applies both enriched and legacy off-air feedback as stopped state", () => {
  const previous = normalizeProgramSongPlayback({
    token: "song-1:audio",
    audioUrl: "https://example.test/song.mp3",
    progress: 0.5,
    currentTimeMs: 30_000,
    durationMs: 60_000,
    isPlaying: true,
    updatedAt: "2026-09-11T12:00:30.000Z",
  });

  expect(
    reconcileProgramSongOffAir(previous, undefined, "2026-09-11T12:01:00.000Z"),
  ).toMatchObject({
    token: "song-1:audio",
    isPlaying: false,
    updatedAt: "2026-09-11T12:01:00.000Z",
  });
  expect(
    reconcileProgramSongOffAir(
      previous,
      {
        token: "",
        audioUrl: "",
        progress: 0,
        currentTimeMs: 0,
        durationMs: null,
        isPlaying: false,
        updatedAt: "2026-09-11T12:02:00.000Z",
      },
      undefined,
    ),
  ).toMatchObject({ token: "", isPlaying: false });
});
