import { vi } from "vitest";
import type {
  FlightCue,
  FlightSequence,
  InstantItem,
  Scene,
  SongCatalogItem,
} from "../app/models/broadcast";

// Shared fixtures for the ManualRundown specs: an operator-cue rundown with a
// server stand-in that applies each saved change, as the flight API does.

export const song = (
  id: number,
  title: string,
  artist: string,
): SongCatalogItem => ({
  id,
  title,
  artist,
  durationMs: 60_000,
  audioUrl: `https://media.example/${id}.mp3`,
  coverUrl: null,
  earoneSongId: null,
  earoneRank: null,
  earoneSpins: null,
  enabled: true,
});

export const instant = (id: number, name: string): InstantItem => ({
  id,
  name,
  audioUrl: `https://media.example/instant-${id}.mp3`,
  volume: 1,
  enabled: true,
  position: id,
});

export const scene = (id: number, name: string, metadata: string | null) =>
  ({ id, name, metadata }) as unknown as Scene;

export const rundown = (
  id: number,
  name: string,
  items: FlightCue[],
  overrides: Partial<FlightSequence> = {},
): FlightSequence => ({
  id,
  name,
  revision: 1,
  items,
  scheduledAt: null,
  publishedAt: null,
  lastStartedAt: null,
  isRunning: false,
  activeItemId: null,
  loop: false,
  createdAt: "",
  updatedAt: "",
  ...overrides,
});

export interface Library {
  state?: unknown;
  stateOk?: boolean;
  songs?: unknown;
  songsOk?: boolean;
  songsThrow?: boolean;
  instants?: unknown;
  instantsOk?: boolean;
  instantsThrow?: boolean;
}

/** Stubs the program state, song and instant endpoints. */
export function stubLibrary({
  state = { activeFlightSequenceId: null, scenes: [] },
  stateOk = true,
  songs = { data: [song(1, "Harbor Light", "The Lighthouse Keepers")] },
  songsOk = true,
  songsThrow = false,
  instants = [instant(5, "Applause")],
  instantsOk = true,
  instantsThrow = false,
}: Library = {}) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/state"))
      return stateOk
        ? Response.json(state)
        : new Response(null, { status: 500 });
    if (url.includes("/songs")) {
      if (songsThrow) throw new Error("songs offline");
      return songsOk
        ? Response.json(songs)
        : new Response(null, { status: 500 });
    }
    if (url.includes("/instants")) {
      if (instantsThrow) throw new Error("instants offline");
      return instantsOk
        ? Response.json(instants)
        : new Response(null, { status: 500 });
    }
    throw new Error(`unexpected ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** jsdom has no modal dialog; open and close it as a browser would. */
export function stubDialog() {
  HTMLDialogElement.prototype.showModal = function showModal() {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function close() {
    this.open = false;
  };
}

/** A native select in place of Bleecker's Radix select, which jsdom cannot open. */
export async function nativeSelect(
  original: () => Promise<typeof import("@gaulatti/bleecker")>,
) {
  const actual = await original();
  return {
    ...actual,
    Select: ({
      options,
      onChange,
      value,
      ...props
    }: {
      options: { value: string; label: string }[];
      onChange: (value: string) => void;
      value: string;
    }) => (
      <select
        {...props}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    ),
  };
}
