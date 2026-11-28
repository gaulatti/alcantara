import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router";
import { RadioPanel } from "./RadioPanel";
import { RadioMonitorProvider } from "./RadioMonitor";
import { pressPreListen, radioPanelProps } from "./RadioPanel.fixture";
import * as flight from "../services/flight";

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

beforeEach(() => {
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
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

it("advances and stops the rundown from its transport, which the timed block always shows", async () => {
  mount();
  const advance = screen.getByRole("button", { name: "Advance rundown" });
  expect(advance).toBeEnabled();
  expect(screen.getByRole("button", { name: "Start rundown" })).toBeDisabled();
  fireEvent.click(advance);
  await waitFor(() => expect(flight.goFlight).toHaveBeenCalledWith("radio-demo"));
  fireEvent.click(screen.getByRole("button", { name: "Stop rundown / Take Off Air" }));
  await waitFor(() => expect(flight.stopFlight).toHaveBeenCalledWith("radio-demo"));
});

it("disables advance on the last item of the rundown", () => {
  const base = radioPanelProps();
  const log = base.fixtureData!.logs[0];
  mount({
    fixtureData: {
      ...base.fixtureData!,
      logs: [{ ...log, activeItemId: `cue-${log.items.length}` }],
    },
  });
  expect(screen.getByRole("button", { name: "Advance rundown" })).toBeDisabled();
});

it("pre-listens the song on air, and lets it go when the press ends", () => {
  const { unmount } = mount();
  const control = pressPreListen(screen, "Music");
  fireEvent.pointerDown(control);
  fireEvent.pointerUp(control);
  fireEvent.click(control);
  expect(control).toBeInTheDocument();
  unmount();
});
