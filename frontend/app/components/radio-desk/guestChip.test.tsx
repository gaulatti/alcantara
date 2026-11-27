import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import { guestChip, type DeskGuest } from "./guestChip";
import { LiveOnAirStrip } from "./OnAirStrip";
import type { OnAirInput } from "./onAir";

// alcantara#875: who is on the call is said in the strip that never scrolls away. Fictional names.
const guest = (name: string, extra: Partial<DeskGuest> = {}): DeskGuest => ({
  identity: `guest-${name}`,
  name,
  connectionState: "connected",
  commands: [],
  ...extra,
});
const live: Partial<DeskGuest> = { commands: [{ type: "cue", payload: { cue: "live" } }] };
const waiting = { screening: true, connectionState: "reconnecting" } as const;

afterEach(cleanup);

describe("guestChip", () => {
  it("says nothing when no one is on the call or waiting", () => {
    expect(guestChip([])).toBeNull();
    expect(guestChip([guest("Ada", { connectionState: "offline" })])).toBeNull();
  });

  it("names a single guest with where they are", () => {
    expect(guestChip([guest("Ada")])).toMatchObject({ label: "Ada: off air", tone: "info", href: "/calls" });
    expect(guestChip([guest("Ada", live)])).toMatchObject({ label: "Ada: on air", tone: "bad" });
    expect(guestChip([guest("Ada", waiting)])).toMatchObject({ label: "Ada: waiting", tone: "warn" });
  });

  it("counts several, with someone waiting shown as needing attention", () => {
    const chip = guestChip([guest("Ada", live), guest("Bo"), guest("Cy", waiting)]);
    expect(chip).toMatchObject({ label: "Guests: 1 on air, 1 waiting, 1 off air", tone: "warn" });
    expect(chip?.title).toBe("Ada: cued live; Bo: on the call, off air; Cy: waiting to be let in");
    expect(guestChip([guest("Ada", live), guest("Bo", live)])).toMatchObject({ label: "Guests: 2 on air", tone: "bad" });
  });

  it("appears in the on-air strip as a link to the caller desk", () => {
    const input: Omit<OnAirInput, "outputUnverified"> = {
      playback: null,
      next: null,
      mode: "manual",
      streamRunning: true,
      engine: { connected: true, degraded: false, unavailableLabel: "Engine unavailable" },
      monitor: "stopped",
    };
    render(
      <MemoryRouter>
        <LiveOnAirStrip input={input} output={null} programId="radio-demo" guests={[guest("Ada", live)]} />
      </MemoryRouter>,
    );
    expect(screen.getByRole("link", { name: "Ada: on air. Open guest calls" })).toHaveAttribute("href", "/calls");
  });
});
