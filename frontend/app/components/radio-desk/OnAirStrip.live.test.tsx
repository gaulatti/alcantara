import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { OnAirStrip } from "./OnAirStrip";
import type { OnAirView } from "./onAir";

// The on-air state is a polite status: a change from On air to Off air is read out, and the clock
// (which ticks every second) is not part of that status. Fictional names only.

afterEach(cleanup);

const view = (patch: Partial<OnAirView> = {}): OnAirView => ({
  state: "on-air",
  label: "On air",
  title: "Harbor Light",
  artist: "The Lighthouse Keepers",
  elapsedMs: 60_000,
  remainingMs: 154_000,
  intro: null,
  next: null,
  modeLabel: "Auto",
  chips: [],
  ...patch,
});

it("announces the on-air state as a status, and the change to off air", () => {
  const { rerender } = render(<OnAirStrip programId="radio-main" view={view()} />);
  expect(screen.getByRole("status")).toHaveTextContent(/^On air$/);

  rerender(
    <OnAirStrip
      programId="radio-main"
      view={view({ state: "off-air", label: "Off air", title: null, artist: null, elapsedMs: null, remainingMs: null, intro: null })}
    />,
  );
  expect(screen.getByRole("status")).toHaveTextContent(/^Off air$/);
});
