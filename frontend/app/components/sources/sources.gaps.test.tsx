import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AudioMeter } from "./AudioMeter";
import { SourceList } from "./SourceList";
import { SourcePreviewTile } from "./SourcePreviewTile";
import { SourceRow, getHealthBadge, getLifecycleBadge } from "./SourceRow";
import { SourcesSubscriptionContext } from "./SourcesSubscriptionContext";

const source = (over: any = {}) => ({
  id: "s1",
  name: "Cam",
  transport: "rtmp",
  lifecycle: "connected",
  health: "healthy",
  participantIdentity: "cam",
  lastConnectedAt: null,
  revokedAt: null,
  programIds: ["p"],
  ...over,
});

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("AudioMeter from an audio track", () => {
  let frames: FrameRequestCallback[];
  let bins: number[];
  let ctxs: any[];
  beforeEach(() => {
    frames = [];
    bins = [255, 255, 255, 255];
    ctxs = [];
    class FakeTrack {}
    class FakeStream {
      constructor(public tracks: unknown[]) {}
    }
    class FakeContext {
      state = "running";
      source = { connect: vi.fn(), disconnect: vi.fn() };
      analyser = {
        fftSize: 0,
        frequencyBinCount: 4,
        getByteFrequencyData: (b: Uint8Array) => b.set(bins),
      };
      close = vi.fn().mockResolvedValue(undefined);
      createAnalyser() {
        return this.analyser;
      }
      createMediaStreamSource() {
        return this.source;
      }
      constructor() {
        ctxs.push(this);
      }
    }
    vi.stubGlobal("MediaStreamTrack", FakeTrack);
    vi.stubGlobal("MediaStream", FakeStream);
    vi.stubGlobal("AudioContext", FakeContext);
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => frames.push(cb));
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    (globalThis as any).__Track = FakeTrack;
  });

  it("measures the track's level each frame, and cleans up", () => {
    const track = new (globalThis as any).__Track();
    const { unmount } = render(<AudioMeter audioTrack={track} />);
    expect(screen.getByRole("meter")).toHaveAttribute("aria-valuenow", "100");
    bins = [0, 0, 0, 0];
    act(() => frames[frames.length - 1](0));
    expect(screen.getByRole("meter")).toHaveAttribute("aria-valuenow", "0");
    unmount();
    expect(ctxs[0].source.disconnect).toHaveBeenCalled();
    expect(ctxs[0].close).toHaveBeenCalled();
    expect(cancelAnimationFrame).toHaveBeenCalled();
  });
  it("accepts a wrapper that carries the media stream track, and leaves a closed context alone", () => {
    const track = { mediaStreamTrack: new (globalThis as any).__Track() };
    const { unmount } = render(<AudioMeter audioTrack={track} />);
    ctxs[0].state = "closed";
    unmount();
    expect(ctxs[0].close).not.toHaveBeenCalled();
  });
  it("shows silence for something that is not a media track or without an audio context", () => {
    render(<AudioMeter audioTrack={{ nope: true }} />);
    expect(screen.getByRole("meter")).toHaveAttribute("aria-valuenow", "0");
    cleanup();
    vi.stubGlobal("AudioContext", undefined);
    render(<AudioMeter audioTrack={new (globalThis as any).__Track()} />);
    expect(screen.getByRole("meter")).toHaveAttribute("aria-valuenow", "0");
  });
  it("falls back to the prefixed audio context", () => {
    vi.stubGlobal("AudioContext", undefined);
    const prefixed = vi.fn(function (this: any) {
      this.createAnalyser = () => ({ frequencyBinCount: 1, getByteFrequencyData: (b: Uint8Array) => b.set([51]) });
      this.createMediaStreamSource = () => ({ connect: vi.fn(), disconnect: vi.fn() });
      this.state = "closed";
    });
    (window as any).webkitAudioContext = prefixed;
    render(<AudioMeter audioTrack={new (globalThis as any).__Track()} />);
    expect(screen.getByRole("meter")).toHaveAttribute("aria-valuenow", "20");
    delete (window as any).webkitAudioContext;
  });
  it("shows silence when the audio graph cannot be built, and ignores a failure to close", async () => {
    class Broken {
      constructor() {
        throw new Error("denied");
      }
    }
    vi.stubGlobal("AudioContext", Broken);
    render(<AudioMeter audioTrack={new (globalThis as any).__Track()} />);
    expect(screen.getByRole("meter")).toHaveAttribute("aria-valuenow", "0");
    cleanup();
    vi.stubGlobal("AudioContext", class {
      state = "running";
      close = vi.fn().mockRejectedValue(new Error("x"));
      createAnalyser = () => ({ frequencyBinCount: 1, getByteFrequencyData: (b: Uint8Array) => b.set([0]) });
      createMediaStreamSource = () => ({ connect: vi.fn(), disconnect: vi.fn() });
    });
    const { unmount } = render(<AudioMeter audioTrack={new (globalThis as any).__Track()} />);
    unmount();
    await act(async () => {});
  });
  it("renders without a level or track as silence with a custom class", () => {
    render(<AudioMeter className="extra" />);
    expect(screen.getByTestId("audio-meter")).toHaveClass("extra");
    expect(screen.getByText("0%")).toBeInTheDocument();
  });
});

describe("SourceRow", () => {
  it("describes every lifecycle and health", () => {
    for (const l of ["connected", "degraded", "reconnecting", "waiting", "provisioning", "unconfigured", "offline", "revoked"] as const) expect(getLifecycleBadge(l).label).toBe(l);
    for (const h of ["healthy", "degraded", "unavailable", "unknown"] as const) expect(getHealthBadge(h).label).toBe(h);
    expect(getHealthBadge("other" as any).label).toBe("unknown");
  });
  const row = (props: any) => render(<table><tbody><SourceRow onToggleSelect={vi.fn()} isSelected={false} {...props} /></tbody></table>);
  it("explains a source that cannot be previewed in its lifecycle", () => {
    row({ source: source({ lifecycle: "revoked" }) });
    const button = screen.getByRole("button");
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-label", "Cam cannot be previewed in revoked state");
  });
  it("explains a page-level reason, and keeps a selected source operable", () => {
    const onToggleSelect = vi.fn();
    row({ source: source(), previewUnavailableReason: "Media service down", onToggleSelect });
    expect(screen.getByRole("button")).toBeDisabled();
    expect(screen.getByText("Media service down")).toBeInTheDocument();
    cleanup();
    row({ source: source(), previewUnavailableReason: "Media service down", isSelected: true, onToggleSelect });
    expect(screen.getByRole("button", { name: "Stop previewing Cam" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button"));
    expect(onToggleSelect).toHaveBeenCalledTimes(1);
  });
  it("falls back to no title when the reason is missing", () => {
    const { container } = row({ source: source(), previewUnavailableReason: "" });
    expect(container.querySelector("button")).toBeInTheDocument();
  });
  it("offers to preview an available source", () => {
    const onToggleSelect = vi.fn();
    row({ source: source(), onToggleSelect });
    fireEvent.click(screen.getByRole("button", { name: "Preview Cam" }));
    expect(onToggleSelect).toHaveBeenCalled();
  });
});

describe("SourceList", () => {
  it("shows an empty state for a program without sources", () => {
    render(<SourceList sources={[source({ programIds: ["other"] })]} currentProgramId="p" selectedIds={new Set()} onToggleSelect={vi.fn()} onRefresh={vi.fn()} />);
    expect(screen.getByText("No external sources assigned")).toBeInTheDocument();
  });
  it("keeps focus on the element that had it across a refresh render", () => {
    const props = { sources: [source()], currentProgramId: "p", selectedIds: new Set<string>(), onToggleSelect: vi.fn(), onRefresh: vi.fn() };
    const { rerender, container } = render(<SourceList {...props} />);
    const cell = container.querySelector("tr[data-testid='source-row-s1']") as HTMLElement;
    cell.id = "focus-target";
    cell.tabIndex = -1;
    fireEvent.focusIn(cell);
    expect(document.activeElement).not.toBe(cell);
    rerender(<SourceList {...props} isLoading />);
    expect(document.activeElement).toBe(cell);
    rerender(<SourceList {...props} />);
    expect(document.activeElement).toBe(cell);
  });
  it("ignores focus on elements without an id, and a remembered element that is gone", () => {
    const props = { sources: [source()], currentProgramId: "p", selectedIds: new Set<string>(), onToggleSelect: vi.fn(), onRefresh: vi.fn() };
    const { container, rerender } = render(<SourceList {...props} />);
    fireEvent.focusIn(container.firstElementChild!);
    const row = container.querySelector("tr[data-testid='source-row-s1']") as HTMLElement;
    row.id = "gone";
    fireEvent.focusIn(row);
    row.removeAttribute("id");
    rerender(<SourceList {...props} isLoading />);
  });
});

describe("SourcePreviewTile status", () => {
  const withState = (src: any, state: any = {}) =>
    render(
      <SourcesSubscriptionContext.Provider
        value={{ room: null, subscribeSource: vi.fn(), getSourceState: vi.fn(), useSourceSubscription: () => ({ participantIdentity: "cam", videoTrack: null, audioTrack: null, audioLevel: 0, error: null, isSubscribed: true, ...state }) } as any}
      >
        <SourcePreviewTile source={src} onDeselect={vi.fn()} />
      </SourcesSubscriptionContext.Provider>,
    );
  it("badges each lifecycle", () => {
    for (const lifecycle of ["connected", "degraded", "reconnecting", "waiting"]) {
      const view = withState(source({ lifecycle }));
      expect(screen.getByText(lifecycle)).toBeInTheDocument();
      view.unmount();
    }
  });
  it("attaches and detaches a video track that lacks attach/detach safely", () => {
    const view = withState(source(), { videoTrack: {} });
    view.unmount();
    const track = { attach: vi.fn(), detach: vi.fn() };
    const second = withState(source(), { videoTrack: track });
    expect(track.attach).toHaveBeenCalled();
    second.unmount();
    expect(track.detach).toHaveBeenCalled();
  });
});

describe("SourceRow without a participant", () => {
  it("says there is no participant when the source has none", () => {
    render(<table><tbody><SourceRow onToggleSelect={vi.fn()} isSelected={false} source={source({ participantIdentity: null })} /></tbody></table>);
    expect(screen.getByText("No participant")).toBeInTheDocument();
  });
});
