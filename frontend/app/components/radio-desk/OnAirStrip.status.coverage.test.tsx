import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { OnAirStrip } from "./OnAirStrip";
import type { OnAirView } from "./onAir";

// The on-air strip's status button: it opens its detail on hover, on click and on focus, closes on leaving, on a
// second click and on Escape. Fictional names only.

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

const statusButton = () => screen.getByRole("button", { name: /Status: all well/ });

it("opens the status detail on hover and closes it when the pointer leaves", () => {
  render(<OnAirStrip programId="tv-main" view={view()} />);
  const button = statusButton();
  expect(button).toHaveAttribute("aria-expanded", "false");
  fireEvent.mouseEnter(button.closest(".desk-status")!);
  expect(button).toHaveAttribute("aria-expanded", "true");
  fireEvent.mouseLeave(button.closest(".desk-status")!);
  expect(button).toHaveAttribute("aria-expanded", "false");
});

it("toggles the status detail on each click", () => {
  render(<OnAirStrip programId="tv-main" view={view()} />);
  const button = statusButton();
  fireEvent.click(button);
  expect(button).toHaveAttribute("aria-expanded", "true");
  fireEvent.click(button);
  expect(button).toHaveAttribute("aria-expanded", "false");
});

it("closes the status detail on Escape, and ignores other keys", () => {
  render(<OnAirStrip programId="tv-main" view={view()} />);
  const button = statusButton();
  fireEvent.click(button);
  expect(button).toHaveAttribute("aria-expanded", "true");
  fireEvent.keyDown(button.closest(".desk-status")!, { key: "Enter" });
  expect(button).toHaveAttribute("aria-expanded", "true");
  fireEvent.keyDown(button.closest(".desk-status")!, { key: "Escape" });
  expect(button).toHaveAttribute("aria-expanded", "false");
});
