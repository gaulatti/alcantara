import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { GuestOnAirState, guestOnAirCopy } from "./GuestOnAirState";

describe("guest on-air state", () => {
  it("is on air only for a live cue", () => {
    expect(guestOnAirCopy("live")).toMatchObject({ title: "You're on air", onAir: true });
  });

  it.each(["standby", "wrap"] as const)("is off air for a %s cue", (cue) => {
    expect(guestOnAirCopy(cue)).toMatchObject({ title: "Off air", onAir: false });
  });

  it("shows the banner as a polite status with its state", () => {
    const { unmount } = render(<GuestOnAirState cue="live" />);
    const banner = screen.getByRole("status");
    expect(banner).toHaveAttribute("aria-live", "polite");
    expect(banner).toHaveAttribute("data-on-air", "true");
    expect(screen.getByText("You're on air")).toBeVisible();
    unmount();
    render(<GuestOnAirState cue="standby" />);
    expect(screen.getByRole("status")).toHaveAttribute("data-on-air", "false");
    expect(screen.getByText("Off air")).toBeVisible();
  });
});
