import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { OnAirStrip } from "./OnAirStrip";
import type { OnAirView } from "./onAir";

// gaulatti/alcantara#527: the next-up line of the on-air strip, with and without a detail, and with nothing
// cued after the current item. Fictional names only.

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

it("shows the next item with its detail", () => {
  render(
    <OnAirStrip
      programId="tv-main"
      view={view({ next: { title: "Second Tide", detail: "The Pilots · 3:34" } })}
    />,
  );
  expect(screen.getByText("Second Tide")).toBeInTheDocument();
  expect(screen.getByText(/The Pilots · 3:34/)).toBeInTheDocument();
  expect(screen.getByText("Next · Auto")).toBeInTheDocument();
});

it("shows the next item without a detail", () => {
  render(
    <OnAirStrip programId="tv-main" view={view({ next: { title: "Paper Lanterns", detail: "" } })} />,
  );
  expect(screen.getByText("Paper Lanterns")).toBeInTheDocument();
  expect(screen.getByText("Paper Lanterns").closest("p")?.textContent).toBe("Paper Lanterns");
});

it("says nothing is cued when there is no next item", () => {
  render(<OnAirStrip programId="tv-main" view={view({ next: null })} />);
  expect(screen.getByText("Nothing cued")).toBeInTheDocument();
});
