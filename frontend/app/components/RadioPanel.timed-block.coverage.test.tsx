import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router";
import { RadioPanel } from "./RadioPanel";
import { RadioMonitorProvider } from "./RadioMonitor";
import { radioPanelProps } from "./RadioPanel.fixture";

// The radio desk's timed block: the on-air rundown with a playing song and cartwall, and the branches a rundown's
// position and an ended cartwall sound take. Fictional names only.

vi.mock("../services/flight", () => ({
  fetchFlightSequences: vi.fn(),
  updateFlightSequence: vi.fn(),
  activateFlightSequence: vi.fn(),
  startFlight: vi.fn(),
  stopFlight: vi.fn(),
  goFlight: vi.fn(),
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function mount(overrides: Parameters<typeof radioPanelProps>[0] = {}) {
  return render(
    <MemoryRouter>
      <RadioMonitorProvider>
        <RadioPanel {...radioPanelProps(overrides)} />
      </RadioMonitorProvider>
    </MemoryRouter>,
  );
}

it("renders a timed block with no song playing and a cartwall sound that has ended, without the playing song", () => {
  const { container } = mount({
    programSongPlayback: null,
    instantPlayback: {
      1: { startedAtMs: Date.now() - 60_000, endsAtMs: Date.now() - 1_000 } as never,
    },
  });
  expect(container.textContent).toBeTruthy();
  expect(container.querySelector('[data-testid="pre-listen-source-music"]')).toBeNull();
});

it("renders a timed block whose current song has gone stale", () => {
  const { container } = mount({
    programSongPlayback: {
      ...radioPanelProps().programSongPlayback!,
      telemetryStale: true,
    },
  });
  expect(container.textContent).toBeTruthy();
});

it("renders a timed block whose cartwall sound is still sounding", () => {
  const { container } = mount({
    instantPlayback: {
      1: { startedAtMs: Date.now() - 2_000, endsAtMs: Date.now() + 60_000 } as never,
    },
  });
  expect(container.textContent).toBeTruthy();
});
