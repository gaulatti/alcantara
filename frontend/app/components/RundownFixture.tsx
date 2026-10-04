import ScheduledRundown from "./ScheduledRundown";
import type {
  FlightSequence,
  SongCatalogItem,
  InstantItem,
} from "../models/broadcast";

export const rundownFixtureSongs: SongCatalogItem[] = Array.from(
  { length: 14 },
  (_, index) => ({
    id: index + 1,
    title: [
      "Morning signal",
      "City lights",
      "Coastline",
      "Open road",
      "Late summer",
      "Golden hour",
      "After the rain",
    ][index % 7],
    artist: ["North Avenue", "Studio Eight", "The Frequencies"][index % 3],
    audioUrl: "https://example.test/fixture.mp3",
    coverUrl: null,
    durationMs: 180000 + (index % 3) * 20000,
    earoneSongId: null,
    earoneRank: null,
    earoneSpins: null,
    enabled: true,
  }),
);
export const rundownFixtureClips: InstantItem[] = [
  {
    id: 1,
    name: "News bulletin",
    audioUrl: "https://example.test/news.mp3",
    volume: 1,
    enabled: true,
    position: 0,
  },
];
export const rundownFixtureLog: FlightSequence = {
  id: 701,
  name: "Morning hour",
  scheduledAt: "2027-01-12T14:00:00Z",
  publishedAt: null,
  lastStartedAt: null,
  revision: 3,
  loop: false,
  isRunning: false,
  activeItemId: null,
  createdAt: "",
  updatedAt: "",
  items: [
    {
      id: "news",
      kind: "instant",
      instantId: 1,
      durationMs: 180000,
      clockOffsetSeconds: 0,
    },
    ...rundownFixtureSongs.slice(0, 4).map((song, index) => ({
      id: `music-${index}`,
      kind: "playSong" as const,
      songId: song.id,
      isFiller: true,
    })),
    {
      id: "mid-news",
      kind: "instant",
      instantId: 1,
      durationMs: 120000,
      clockOffsetSeconds: 900,
    },
    ...rundownFixtureSongs.slice(4, 8).map((song, index) => ({
      id: `rotation-${index}`,
      kind: "playSong" as const,
      songId: song.id,
      isFiller: true,
    })),
    {
      id: "fixed-music",
      kind: "playSong",
      songId: 10,
      clockOffsetSeconds: 1800,
    },
    ...rundownFixtureSongs.slice(10, 14).map((song, index) => ({
      id: `late-${index}`,
      kind: "playSong" as const,
      songId: song.id,
      isFiller: true,
    })),
    {
      id: "end",
      kind: "stopSong",
      clockOffsetSeconds: 3600,
      label: "End of hour",
      isFiller: true,
    },
  ],
};
const data = {
  logs: [rundownFixtureLog],
  songs: rundownFixtureSongs,
  clips: rundownFixtureClips,
};
export function RundownFixture() {
  return <ScheduledRundown fixtureData={data} />;
}
