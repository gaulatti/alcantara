import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import { TvAudioWorkspace, type TvAudioChannel } from "./TvAudioWorkspace";
import { dbToFader } from "../utils/audioTaper";

beforeEach(() =>
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  ),
);
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
function props(): ComponentProps<typeof TvAudioWorkspace> {
  const channels: TvAudioChannel[] = (
    ["song", "stream", "instants", "sceneInstant", "main"] as const
  ).map((id, index) => ({
    id,
    label: ["Music", "Stream", "Cartwall", "Scene audio", "Main mix"][index],
    volume: 0.8,
    muted: false,
    solo: false,
    onVolumeChange: vi.fn(),
    ...(id === "stream" ? {} : { meter: { fill: 0.2, peak: 0.3, hold: 0.4 } }),
    ...(id === "main"
      ? {}
      : {
          onToggleMuted: vi.fn(),
          onToggleSolo: vi.fn(),
          presets: { aDb: -15, bDb: -30 },
          onCommitPreset: vi.fn(() => -12),
          onTake: vi.fn(),
        }),
  }));
  return {
    programId: "tv demo",
    activeScene: { id: 1, name: "Studio camera" } as any,
    mixer: {
      channels,
      fadeMs: 5000,
      onFadeChange: vi.fn(),
      loading: false,
      saving: false,
      error: null,
    },
    music: {
      sequence: {
        mode: "manual",
        loop: false,
        activeItemId: null,
        items: Array.from({ length: 12 }, (_, i) => ({
          id: String(i),
          kind: "preset" as const,
          title: `Song ${i + 1}`,
          artist: "Local artist",
          audioUrl: `https://example.test/${i}.mp3`,
          coverUrl: "",
          durationMs: 180000,
        })),
      },
      songCatalog: [],
      programSongPlayback: null,
      onChange: vi.fn(),
      onTakeSelection: vi.fn(),
      onAddSongs: vi.fn(),
    },
    cartwall: {
      instants: [
        {
          id: 1,
          name: "Station ID",
          audioUrl: "https://example.test/id.mp3",
          enabled: true,
          position: 0,
          volume: 1,
        },
        {
          id: 2,
          name: "Disabled clip",
          audioUrl: "https://example.test/disabled.mp3",
          enabled: false,
          position: 1,
          volume: 1,
        },
      ],
      isLoading: false,
      search: "",
      playback: {},
      onSearchChange: vi.fn(),
      onTrigger: vi.fn(),
      onStopAll: vi.fn(),
    },
    recording: (
      <details>
        <summary>Program recording</summary>
      </details>
    ),
  };
}
it("renders the complete desk with one monitor, every channel, twelve songs and one cartwall search", () => {
  render(<TvAudioWorkspace {...props()} />);
  expect(screen.getAllByTitle("PROGRAM confidence monitor")).toHaveLength(1);
  expect(screen.getByTitle("PROGRAM confidence monitor")).toHaveAttribute(
    "src",
    "/program/tv%20demo?confidence=program",
  );
  expect(screen.queryByText(/Program stays visible/)).not.toBeInTheDocument();
  expect(screen.getAllByRole("slider")).toHaveLength(5);
  expect(screen.getAllByRole("meter")).toHaveLength(4);
  expect(screen.getByText("Song 12")).toBeInTheDocument();
  expect(
    screen.getAllByRole("textbox", { name: "Search cartwall" }),
  ).toHaveLength(1);
  expect(screen.getByRole("button", { name: "Disabled clip" })).toBeDisabled();
  expect(
    screen.queryByRole("button", { name: "Mute Main mix" }),
  ).not.toBeInTheDocument();
});
it("routes faders, exact dB inputs, mute, solo and A/B takes to each channel independently", () => {
  const data = props();
  render(<TvAudioWorkspace {...data} />);
  for (const channel of data.mixer.channels) {
    fireEvent.change(
      screen.getByRole("slider", { name: `${channel.label} fader` }),
      { target: { value: ".5" } },
    );
    expect(channel.onVolumeChange).toHaveBeenLastCalledWith(0.5);
    fireEvent.blur(
      screen.getByRole("textbox", { name: `${channel.label} level in dB` }),
      { target: { value: "-15" } },
    );
    expect(channel.onVolumeChange).toHaveBeenLastCalledWith(dbToFader(-15));
    if (channel.id === "main") continue;
    fireEvent.click(
      screen.getByRole("button", { name: `Mute ${channel.label}` }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: `Solo ${channel.label}` }),
    );
    expect(channel.onToggleMuted).toHaveBeenCalledTimes(1);
    expect(channel.onToggleSolo).toHaveBeenCalledTimes(1);
    for (const side of ["a", "b"] as const) {
      fireEvent.blur(
        screen.getByRole("textbox", {
          name: `${channel.label} preset ${side.toUpperCase()} in dB`,
        }),
        { target: { value: "-12" } },
      );
      expect(channel.onCommitPreset).toHaveBeenLastCalledWith(side, "-12");
      fireEvent.click(
        screen.getByRole("button", {
          name: `Take ${channel.label} preset ${side.toUpperCase()}`,
        }),
      );
      expect(channel.onTake).toHaveBeenLastCalledWith(side);
    }
  }
  fireEvent.change(
    screen.getByRole("spinbutton", { name: "Preset fade in milliseconds" }),
    { target: { value: "800" } },
  );
  expect(data.mixer.onFadeChange).toHaveBeenCalledWith(800);
});
it("keeps music selection and cartwall operations usable in their own panels", () => {
  const data = props();
  render(<TvAudioWorkspace {...data} />);
  fireEvent.click(screen.getByRole("button", { name: "Add songs" }));
  expect(data.music.onAddSongs).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "Station ID" }));
  expect(data.cartwall.onTrigger).toHaveBeenCalledWith(1);
  fireEvent.change(screen.getByRole("textbox", { name: "Search cartwall" }), {
    target: { value: "station" },
  });
  expect(data.cartwall.onSearchChange).toHaveBeenCalledWith("station");
  fireEvent.click(screen.getByRole("button", { name: "Stop all" }));
  expect(data.cartwall.onStopAll).toHaveBeenCalledTimes(1);
  // The row TAKE retains the existing sequence editor operation.
  fireEvent.click(screen.getAllByRole("button", { name: "Take on air" })[1]);
  expect(data.music.onTakeSelection).toHaveBeenCalledWith(
    expect.objectContaining({ activeItemId: "1" }),
  );
});
it("shows loading and failed persistence explicitly and reflects acknowledged mute and solo states", () => {
  const data = props();
  data.mixer.loading = true;
  data.mixer.channels[0].muted = true;
  data.mixer.channels[0].solo = true;
  const { rerender } = render(<TvAudioWorkspace {...data} />);
  expect(screen.getByRole("status")).toHaveTextContent("Loading mixer");
  expect(screen.getByRole("slider", { name: "Music fader" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Mute Music" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect(screen.getByRole("button", { name: "Solo Music" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  data.mixer.loading = false;
  data.mixer.error = "Mixer change was not applied to Palazzo. Try again.";
  rerender(<TvAudioWorkspace {...data} />);
  expect(
    within(screen.getByRole("region", { name: "Audio mixer" })).getByRole(
      "alert",
    ),
  ).toHaveTextContent("not applied");
  expect(screen.queryByText("Mix settings saved")).not.toBeInTheDocument();
});
