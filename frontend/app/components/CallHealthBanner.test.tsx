import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CallHealthBanner, CALL_HEALTH_REFRESH_MS } from "./CallHealthBanner";
import { callHealthWarning } from "../utils/callHealth";

const fetcher = vi.hoisted(() => vi.fn());
vi.mock("../services/api", () => ({ authFetch: fetcher }));

const health = (patch: Record<string, string> = {}) => ({
  returnRunner: "ok",
  contribution: "ok",
  livekit: "ok",
  checkedAt: "2026-11-27T09:00:00.000Z",
  ...patch,
});
const tick = () => act(async () => void (await vi.advanceTimersByTimeAsync(CALL_HEALTH_REFRESH_MS)));

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  fetcher.mockReset();
});

describe("what is said", () => {
  it.each([
    [health({ returnRunner: "down" }), "Guests can't hear the studio right now"],
    [health({ contribution: "down" }), "Guests can't reach air right now"],
    [health({ returnRunner: "down", contribution: "down" }), "Guests can't reach air or hear the studio right now"],
    // Without the calls server the rest follows, so it is the one thing said.
    [health({ livekit: "down", contribution: "down", returnRunner: "down" }), "Calls server unreachable"],
  ])("names what is down: %j", (answer, problem) => {
    const warning = callHealthWarning(answer)!;
    expect(warning.problem).toBe(problem);
    expect(warning.action).not.toBe("");
  });

  it("says nothing when all is ok or unknown, or the answer is not one", () => {
    for (const answer of [health(), health({ livekit: "unknown", contribution: "unknown", returnRunner: "unknown" }), {}, null, "no"])
      expect(callHealthWarning(answer)).toBeNull();
  });
});

describe("the banner", () => {
  it("reads at once and every 10 s, showing the line only while something is down", async () => {
    fetcher.mockResolvedValueOnce(Response.json(health()));
    fetcher.mockResolvedValueOnce(Response.json(health({ contribution: "down" })));
    fetcher.mockResolvedValue(Response.json(health()));
    const view = render(<CallHealthBanner programId="radio one" />);
    await act(async () => void (await vi.advanceTimersByTimeAsync(0)));
    expect(fetcher).toHaveBeenCalledWith("/webrtc/health?programId=radio%20one");
    expect(view.container).toBeEmptyDOMElement();
    await tick();
    expect(screen.getByRole("status")).toHaveTextContent("Guests can't reach air right now.");
    await tick();
    expect(view.container).toBeEmptyDOMElement();
    view.unmount();
    await tick();
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("stays quiet where the endpoint is missing or cannot be read", async () => {
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify(health({ livekit: "down" })), { status: 404 }));
    fetcher.mockRejectedValueOnce(new Error("offline"));
    fetcher.mockResolvedValue(new Response("<html>", { status: 200 }));
    const view = render(<CallHealthBanner programId="main" />);
    for (let read = 0; read < 3; read += 1) {
      await tick();
      expect(view.container).toBeEmptyDOMElement();
    }
  });

  it("never shows one show's answer for another", async () => {
    fetcher.mockResolvedValueOnce(Response.json(health({ livekit: "down" })));
    fetcher.mockReturnValue(new Promise(() => {}));
    const view = render(<CallHealthBanner programId="one" />);
    await act(async () => void (await vi.advanceTimersByTimeAsync(0)));
    expect(screen.getByRole("status")).toHaveTextContent("Calls server unreachable.");
    view.rerender(<CallHealthBanner programId="two" />);
    expect(view.container).toBeEmptyDOMElement();
  });
});
