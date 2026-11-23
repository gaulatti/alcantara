import { act, cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfidenceMonitor } from "./BroadcastSwitcherDeck";
import {
  RETURN_DELAYED_MS,
  RETURN_FROZEN_MS,
  behindLabel,
  returnState,
  sinceLabel,
  type ReturnSource,
} from "../utils/programReturn";
import type { Scene } from "../models/broadcast";
// gaulatti/alcantara#431: no desktop host unless a test plugs one in.
const desktop = vi.hoisted(() => ({ host: null as null | Record<string, unknown> }));
vi.mock("@desktop-host", () => ({
  get default() {
    return desktop.host;
  },
}));


// gaulatti/alcantara#301: the PROGRAM monitor says what it really is. Today it
// is the program page rendered again in this browser, silent, never the output.

const scene = { id: 1, name: "Morning desk" } as Scene;
const NOW = Date.parse("2026-11-22T12:00:00Z");
const ret = (patch: Partial<Extract<ReturnSource, { kind: "return" }>> = {}): ReturnSource => ({
  kind: "return",
  from: "Alana",
  connected: true,
  latencyMs: 1_800,
  lastFrameAt: NOW,
  ...patch,
});

beforeEach(() => {
  vi.useFakeTimers({ now: NOW });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("returnState", () => {
  it("is local without a real return, whatever the program shows", () => {
    expect(returnState({ kind: "local" }, NOW)).toBe("local");
  });
  it("is live, delayed, frozen or lost from the return's own numbers", () => {
    expect(returnState(ret(), NOW)).toBe("live");
    expect(returnState(ret({ latencyMs: RETURN_DELAYED_MS }), NOW)).toBe("live");
    expect(returnState(ret({ latencyMs: RETURN_DELAYED_MS + 1 }), NOW)).toBe("delayed");
    expect(returnState(ret({ latencyMs: null }), NOW)).toBe("live");
    expect(returnState(ret({ lastFrameAt: NOW - RETURN_FROZEN_MS + 1 }), NOW)).toBe("live");
    expect(returnState(ret({ lastFrameAt: NOW - RETURN_FROZEN_MS }), NOW)).toBe("frozen");
    // Frozen outranks delayed: an old frame is the louder fault.
    expect(returnState(ret({ lastFrameAt: NOW - 5_000, latencyMs: 9_000 }), NOW)).toBe("frozen");
    expect(returnState(ret({ connected: false }), NOW)).toBe("lost");
    expect(returnState(ret({ lastFrameAt: null }), NOW)).toBe("lost");
  });
  it("labels the latency and the time since a frame", () => {
    expect(behindLabel(1_840)).toBe("1.8 s behind");
    expect(behindLabel(null)).toBeNull();
    expect(sinceLabel(NOW - 67_000, NOW)).toBe("1:07");
    expect(sinceLabel(NOW + 5_000, NOW)).toBe("0:00");
    expect(sinceLabel(null, NOW)).toBe("—");
  });
});

describe("ConfidenceMonitor", () => {
  it("labels today's PROGRAM iframe as a local render, not the output, with no audio", () => {
    render(
      <ConfidenceMonitor label="PROGRAM" tone="program" scene={scene} src="/program/p?confidence=program" />,
    );
    const monitor = screen.getByRole("region", { name: "PROGRAM monitor, local render" });
    expect(monitor).toHaveAttribute("data-return-state", "local");
    expect(within(monitor).getByRole("note")).toHaveTextContent("Local render · not the output");
    expect(within(monitor).getByText("local render")).toBeVisible();
    expect(within(monitor).getByTitle("PROGRAM confidence monitor")).toBeInTheDocument();
    const listen = within(monitor).getByRole("button", { name: /Listen/ });
    expect(listen).toBeDisabled();
    expect(listen).toHaveAttribute("title", "No return audio: the local render is silent");
    // Nothing claims a live return.
    expect(within(monitor).queryByText("Live")).toBeNull();
    expect(within(monitor).queryByText(/RETURN/)).toBeNull();
  });

  it("labels an empty program as local too", () => {
    render(<ConfidenceMonitor label="PROGRAM" tone="program" scene={null} src="/p" />);
    expect(screen.getByText("No scene selected")).toBeVisible();
    expect(screen.getByRole("note")).toHaveTextContent("Local render · not the output");
  });

  it("marks the preview as a local render, without the program's ribbon or audio", () => {
    render(<ConfidenceMonitor label="PREVIEW" tone="preview" scene={scene} src="/p" />);
    const monitor = screen.getByRole("region", { name: "PREVIEW monitor" });
    expect(monitor).not.toHaveAttribute("data-return-state");
    expect(within(monitor).getByText("local render")).toBeVisible();
    expect(within(monitor).queryByRole("note")).toBeNull();
    expect(within(monitor).queryByRole("button", { name: /Listen/ })).toBeNull();
  });

  it.each([
    ["live", ret(), "Live"],
    ["delayed", ret({ latencyMs: 4_200 }), "Delayed"],
  ] as const)("shows a %s return with its latency and its own picture", (state, source, label) => {
    render(
      <ConfidenceMonitor
        label="PROGRAM"
        tone="program"
        scene={scene}
        src="/p"
        returnSource={source}
        returnMedia={<video aria-label="Alana return" />}
      />,
    );
    const monitor = screen.getByRole("region", { name: "Program return" });
    expect(monitor).toHaveAttribute("data-return-state", state);
    expect(within(monitor).getByText("RETURN · FROM ALANA")).toBeVisible();
    expect(within(monitor).getByText(label)).toHaveAttribute("data-state", state);
    expect(
      within(monitor).getByText(source.kind === "return" ? behindLabel(source.latencyMs)! : ""),
    ).toBeVisible();
    expect(within(monitor).getByLabelText("Alana return")).toBeInTheDocument();
    // A real return replaces the local render entirely.
    expect(within(monitor).queryByTitle("PROGRAM confidence monitor")).toBeNull();
    expect(within(monitor).queryByRole("note")).toBeNull();
    expect(within(monitor).getByRole("button", { name: /Listen/ })).toHaveAttribute(
      "title",
      "Return audio is not available yet",
    );
  });

  it("counts a frozen return's time on the same frame, and says when the picture is missing", () => {
    render(
      <ConfidenceMonitor label="PROGRAM" tone="program" scene={scene} src="/p" returnSource={ret({ lastFrameAt: NOW - 2_500 })} />,
    );
    const monitor = screen.getByRole("region", { name: "Program return" });
    expect(monitor).toHaveAttribute("data-return-state", "frozen");
    expect(within(monitor).getByText("No return picture")).toBeVisible();
    // The missing-picture label sits at the top while the frozen overlay is centred.
    expect(within(monitor).getByText("No return picture")).toHaveClass("items-start");
    expect(within(monitor).getByRole("status")).toHaveTextContent("Frozen · same frame for 0:02");
    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    expect(within(monitor).getByRole("status")).toHaveTextContent("Frozen · same frame for 0:04");
  });

  it("fills the tile when the signal is lost, with the time since the last frame", () => {
    const view = render(
      <ConfidenceMonitor label="PROGRAM" tone="program" scene={scene} src="/p" returnSource={ret({ connected: false, lastFrameAt: NOW - 7_000 })} />,
    );
    const monitor = screen.getByRole("region", { name: "Program return" });
    expect(monitor).toHaveAttribute("data-return-state", "lost");
    expect(within(monitor).getByRole("alert")).toHaveTextContent("Signal lost · 0:07 since the last frame");
    expect(within(monitor).getByText("Signal lost", { selector: "span" })).toBeVisible();
    // The latency of a lost return is not shown.
    expect(within(monitor).queryByText(/behind/)).toBeNull();
    view.rerender(
      <ConfidenceMonitor label="PROGRAM" tone="program" scene={scene} src="/p" returnSource={ret({ lastFrameAt: null })} />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Signal lost · no frame yet");
  });
});

describe("visual fixtures (alcantara#301)", () => {
  it("draw every return state and a caller desk, sending nothing", async () => {
    const { CallerDeskFixture, ProgramReturnFixture } = await import("./ReturnCallersFixture");
    render(<ProgramReturnFixture />);
    expect(
      screen.getAllByRole("region").map((region) => region.getAttribute("data-return-state")),
    ).toEqual(["local", "live", "delayed", "frozen", "lost"]);
    cleanup();
    render(<CallerDeskFixture />);
    expect(screen.getAllByRole("article").map((strip) => strip.getAttribute("data-state"))).toEqual([
      "cued-live",
      "connected",
      "reconnecting",
    ]);
    const message = screen.getByLabelText("Message Diego Montes");
    act(() => {
      message.focus();
    });
    const { fireEvent } = await import("@testing-library/react");
    fireEvent.change(message, { target: { value: "Hi" } });
    expect(message).toHaveValue("Hi");
  });
});

describe("a desktop host's program monitor (gaulatti/alcantara#431)", () => {
  afterEach(() => {
    desktop.host = null;
  });

  it("shows the program's own picture in PROGRAM, labelled as the source, without the local-render ribbon", () => {
    desktop.host = {
      programMonitor: ({ programId }: { programId: string }) => <div data-testid="native-monitor">{programId}</div>,
    };
    render(
      <ConfidenceMonitor label="PROGRAM" tone="program" programId="main" scene={{ id: 1, name: "Desk" } as Scene} src="/program/main?confidence=program" />,
    );
    const tile = screen.getByRole("region", { name: "PROGRAM monitor, program source" });
    expect(within(tile).getByTestId("native-monitor")).toHaveTextContent("main");
    expect(within(tile).getByText("program source")).toBeInTheDocument();
    expect(within(tile).queryByText("Local render · not the output")).toBeNull();
    expect(tile.querySelector("iframe")).toBeNull();
  });

  it("leaves PREVIEW, and PROGRAM without a show, to the local render", () => {
    desktop.host = { programMonitor: () => <div data-testid="native-monitor" /> };
    render(
      <>
        <ConfidenceMonitor label="PREVIEW" tone="preview" programId="main" scene={{ id: 1, name: "Desk" } as Scene} src="/p" />
        <ConfidenceMonitor label="PROGRAM" tone="program" scene={{ id: 1, name: "Desk" } as Scene} src="/p" />
      </>,
    );
    expect(screen.queryByTestId("native-monitor")).toBeNull();
    expect(screen.getByText("Local render · not the output")).toBeInTheDocument();
  });
});
