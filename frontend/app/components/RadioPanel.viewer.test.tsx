import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RadioPanel } from "./RadioPanel";

const granted = vi.hoisted(() => ({ permissions: new Set<string>() }));
vi.mock("../hooks/useFeatures", () => ({
  useFeatures: () => ({
    loading: false,
    context: null,
    hasPermission: (permission: string) => granted.permissions.has(permission),
  }),
}));

const NOTICE = "You can view this show but not run the radio.";
const nothing = () => {};
const panel = (extra: Record<string, unknown> = {}) =>
  createElement(RadioPanel as any, {
    programId: "radio-demo",
    songSequence: null,
    songQueue: [],
    songCatalog: [],
    programSongPlayback: null,
    instants: [],
    instantSearch: "",
    instantPlayback: {},
    mixer: { song: { volume: 1, peak: 0 }, instants: { volume: 1, peak: 0 }, main: { volume: 1, peak: 0 }, saving: false, error: null },
    onSaveSongSequence: nothing,
    onTakeSelection: nothing,
    onQueueSong: nothing,
    onRemoveQueuedSong: nothing,
    onReorderSongQueue: nothing,
    onTakeOffAir: nothing,
    onInstantSearchChange: nothing,
    onTriggerInstant: nothing,
    onStopAllInstants: nothing,
    onSongVolumeChange: nothing,
    onInstantVolumeChange: nothing,
    onMainVolumeChange: nothing,
    onToggleSongMuted: nothing,
    onToggleInstantMuted: nothing,
    ...extra,
  });

const show = (element: ReturnType<typeof panel>) => render(createElement(MemoryRouter, null, element));

beforeEach(() => {
  granted.permissions = new Set();
  vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 403 })));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the radio desk for an account that may only view", () => {
  it("says so once, with no refusal lines, engine fault or transport", async () => {
    show(panel({ songCatalogLoadError: "HTTP 403", instantsLoadError: "HTTP 403" }));
    expect(await screen.findByText(NOTICE)).toBeVisible();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByText(/403/)).toBeNull();
    expect(screen.queryByText(/permission for this rundown/)).toBeNull();
    expect(screen.queryByText(/Engine unavailable/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /cue next/i })).toBeNull();
  });

  it("disables Add fillers, Stop all and the mixer, and leaves Search songs", async () => {
    const calls = {
      onStopAllInstants: vi.fn(),
      onSongVolumeChange: vi.fn(),
      onToggleSongMuted: vi.fn(),
      onToggleInstantMuted: vi.fn(),
    };
    show(panel(calls));
    await screen.findByText(NOTICE);
    expect(screen.getByRole("button", { name: /add fillers/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Stop all sounders" })).toBeDisabled();
    for (const label of ["Music level", "Cartwall level", "Output level"])
      expect(screen.getByRole("slider", { name: label })).toBeDisabled();
    const mutes = screen.getAllByRole("button", { name: /^View only|^MUTE$/ }).filter((button) => button.textContent === "MUTE");
    expect(mutes).toHaveLength(2);
    for (const mute of mutes) {
      expect(mute).toBeDisabled();
      fireEvent.click(mute);
    }
    fireEvent.keyDown(screen.getByRole("slider", { name: "Music level" }), { key: "ArrowDown" });
    const handle = screen.getAllByTestId("fader-handle")[0];
    fireEvent.pointerDown(handle, { clientX: 10, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 90, pointerId: 1 });
    for (const call of Object.values(calls)) expect(call).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /search songs/i })).toBeEnabled();
  });

  it("still shows a failure that is not a refusal", async () => {
    show(panel({ songCatalogLoadError: "HTTP 500" }));
    expect(await screen.findByText("Song library did not load: HTTP 500")).toBeVisible();
  });

  it("keeps the transport and says nothing to an account that may run the radio", async () => {
    granted.permissions = new Set(["alcantara:radio:operate", "alcantara:radio:read"]);
    show(panel({ songCatalogLoadError: "HTTP 403" }));
    expect(await screen.findByText("Song library did not load: HTTP 403")).toBeVisible();
    expect(screen.queryByText(NOTICE)).toBeNull();
    expect(screen.getByRole("button", { name: /cue next/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /add fillers/i })).toBeEnabled();
    expect(screen.getByRole("slider", { name: "Music level" })).toBeEnabled();
  });
});
