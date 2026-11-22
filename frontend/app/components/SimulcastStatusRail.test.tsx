import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { SimulcastStatusRail } from "./SimulcastStatusRail";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function api(palazzo: unknown, palazzoStatus = 200) {
  vi.spyOn(globalThis, "fetch").mockImplementation((async (
    input: RequestInfo | URL,
  ) =>
    String(input).includes("/palazzo-status")
      ? new Response(JSON.stringify(palazzo), { status: palazzoStatus })
      : new Response(JSON.stringify({ running: true }))) as typeof fetch);
}

const status = (extra: Record<string, unknown>) => ({
  connection: "unavailable",
  degraded: false,
  detail: "Radio is disabled in this program’s settings",
  ...extra,
});

it("shows the reason the radio needs attention, and nothing for an unknown or missing one", async () => {
  api(status({ reason: "url-rejected" }));
  render(<SimulcastStatusRail programId="radio-1" />);
  expect(
    await screen.findByText("Radio needs attention: URL not allowed"),
  ).toBeVisible();
  cleanup();
  api(status({ reason: "from-the-future" }));
  render(<SimulcastStatusRail programId="radio-1" />);
  expect(await screen.findByText("Radio needs attention")).toBeVisible();
  cleanup();
  api(null);
  render(<SimulcastStatusRail programId="radio-1" />);
  expect(await screen.findByText("Radio needs attention")).toBeVisible();
});

it("says ready for a live status from an older backend", async () => {
  api({ connection: "connected", degraded: false, detail: null });
  render(<SimulcastStatusRail programId="radio-1" />);
  expect(await screen.findByText("Radio ready")).toBeVisible();
});
