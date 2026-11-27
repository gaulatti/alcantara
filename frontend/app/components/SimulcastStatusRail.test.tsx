import { act, cleanup, render, screen } from "@testing-library/react";
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

const warning = () => screen.queryByRole("region", { name: "Simulcast output status" });
/** Both status calls have answered and the page has taken them in. */
const settled = async () => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
};

it("shows the reason the radio needs attention, and nothing for an unknown or missing one", async () => {
  api(status({ reason: "url-rejected" }));
  render(<SimulcastStatusRail programId="radio-1" />);
  await settled();
  expect(warning()).toHaveTextContent("Radio URL not allowed · Setup");
  expect(screen.getByRole("link", { name: "Setup" })).toHaveAttribute("href", "/radio-settings");
  for (const body of [status({ reason: "from-the-future" }), null]) {
    cleanup();
    api(body);
    render(<SimulcastStatusRail programId="radio-1" />);
    await settled();
    expect(warning()).toHaveTextContent("Radio needs attention · Setup");
  }
});

it("words a disabled radio as Radio disabled · Setup", async () => {
  api(status({ reason: "disabled" }));
  render(<SimulcastStatusRail programId="radio-1" />);
  await settled();
  expect(warning()).toHaveTextContent("Radio disabled · Setup");
  expect(warning()).not.toHaveTextContent("in settings");
});

it("says nothing while the radio is healthy, including a live status from an older backend", async () => {
  for (const body of [{ connection: "connected", degraded: false, detail: null }, status({ connection: "polling", degraded: false })]) {
    api(body);
    render(<SimulcastStatusRail programId="radio-1" />);
    await settled();
    expect(warning()).toBeNull();
    cleanup();
  }
});

it("reports the radio as needing attention when both status calls fail", async () => {
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
  render(<SimulcastStatusRail programId="radio-1" />);
  await settled();
  expect(warning()).toHaveTextContent("Radio needs attention · Setup");
});

it("asks for the status again every eight seconds", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
  try {
    api(status({ connection: "connected", degraded: false }));
    render(<SimulcastStatusRail programId="radio-1" />);
    await act(async () => {
      await Promise.resolve();
    });
    const before = vi.mocked(globalThis.fetch).mock.calls.length;
    await act(async () => {
      vi.advanceTimersByTime(8_000);
      await Promise.resolve();
    });
    expect(vi.mocked(globalThis.fetch).mock.calls.length).toBeGreaterThan(before);
  } finally {
    vi.useRealTimers();
  }
});
