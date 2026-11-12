import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RecordingState, TapeStatus } from "../models/broadcast";
import { TapePanel, TapeStatusView } from "./TapePanel";
import {
  fetchTapeStatus,
  requestTapeDownloadUrl,
  sendTapeCommand,
  TapeApiError,
} from "../services/tape";

vi.mock("../services/tape", async () => {
  class TestTapeApiError extends Error {
    constructor(
      readonly status: number,
      message: string,
    ) {
      super(message);
    }
  }
  return {
    fetchTapeStatus: vi.fn(),
    sendTapeCommand: vi.fn(),
    requestTapeDownloadUrl: vi.fn(),
    newTapeCommandKey: vi.fn((action: string) => `tape-${action}-1`),
    TapeApiError: TestTapeApiError,
  };
});

afterEach(() => cleanup());

const status = (
  state: RecordingState,
  tape: Partial<TapeStatus["tape"]> = {},
): TapeStatus => ({
  tape: { enabled: true, active: false, pipelineHealthy: false, ...tape },
  recording: {
    enabled: true,
    state,
    requestedAt: null,
    startedAt: null,
    stoppedAt: null,
    finalizedAt: state === "complete" ? "2026-11-12T19:00:00Z" : null,
    updatedAt: null,
    segmentCount: 1,
    bytes: 5_000_000,
    durationSeconds: 3_000,
    droppedFrames: 0,
    errors: 0,
    restarts: 0,
    finalizationState:
      state === "complete"
        ? "verified"
        : state === "finalizing"
          ? "pending"
          : "not-requested",
    finalBytes: state === "complete" ? 2_500_000_000 : 0,
    error: null,
    disk: null,
  },
});

const view = (value: TapeStatus | null, handlers = {}) =>
  render(
    <TapeStatusView
      status={value}
      busy={null}
      message=""
      onStart={vi.fn()}
      onStop={vi.fn()}
      onDownload={vi.fn()}
      onRefresh={vi.fn()}
      {...handlers}
    />,
  );

describe("TapeStatusView", () => {
  it("offers Tape when idle and nothing else", () => {
    view(status("idle"));
    expect(screen.getByRole("button", { name: "Tape" })).toBeInTheDocument();
    expect(screen.queryByText(/Download/)).toBeNull();
    expect(screen.queryByText(/Stop and save/)).toBeNull();
  });

  it("explains when taping is disabled and offers no button", () => {
    view(status("disabled", { enabled: false }));
    expect(screen.getByText("Taping is not enabled")).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("shows a private TAPING state with Stop while active", () => {
    view(status("active", { active: true }));
    expect(screen.getByText("TAPING")).toBeInTheDocument();
    expect(screen.getByText(/private, not broadcast/)).toBeInTheDocument();
    expect(screen.getByText(/50:00/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Stop and save" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Tape" })).toBeNull();
  });

  it("blocks everything while finalizing", () => {
    view(status("finalizing", { active: true }));
    expect(screen.getByText(/not ready yet/)).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("offers the verified file for download, and a new tape", () => {
    view(status("complete"));
    expect(
      screen.getByRole("button", { name: /Download MP4 \(2\.5 GB\)/ }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Tape" })).toBeInTheDocument();
  });
});

describe("TapePanel", () => {
  beforeEach(() => {
    vi.mocked(fetchTapeStatus).mockReset();
    vi.mocked(sendTapeCommand).mockReset();
    vi.mocked(requestTapeDownloadUrl).mockReset();
  });

  it("starts a tape with an idempotency key and shows the result", async () => {
    vi.mocked(fetchTapeStatus).mockResolvedValue(status("idle"));
    vi.mocked(sendTapeCommand).mockResolvedValue(
      status("active", { active: true }),
    );
    render(<TapePanel programId="main" />);
    fireEvent.click(await screen.findByRole("button", { name: "Tape" }));
    await waitFor(() =>
      expect(sendTapeCommand).toHaveBeenCalledWith("main", "start", "tape-start-1"),
    );
    expect(await screen.findByText("TAPING")).toBeInTheDocument();
  });

  it("reports a rejected start without changing state", async () => {
    vi.mocked(fetchTapeStatus).mockResolvedValue(status("idle"));
    vi.mocked(sendTapeCommand).mockRejectedValue(
      new TapeApiError(409, "The program is live. End the broadcast before taping."),
    );
    render(<TapePanel programId="main" />);
    fireEvent.click(await screen.findByRole("button", { name: "Tape" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The program is live");
    expect(screen.queryByText("TAPING")).toBeNull();
  });

  it("asks before stopping and does nothing if cancelled", async () => {
    vi.mocked(fetchTapeStatus).mockResolvedValue(status("active", { active: true }));
    vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<TapePanel programId="main" />);
    fireEvent.click(await screen.findByRole("button", { name: "Stop and save" }));
    expect(sendTapeCommand).not.toHaveBeenCalled();
  });

  it("downloads through a short-lived ticket URL", async () => {
    vi.mocked(fetchTapeStatus).mockResolvedValue(status("complete"));
    vi.mocked(requestTapeDownloadUrl).mockResolvedValue(
      "https://api.test/program/main/recording/file?ticket=abc",
    );
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign });
    render(<TapePanel programId="main" />);
    fireEvent.click(await screen.findByRole("button", { name: /Download MP4/ }));
    await waitFor(() =>
      expect(assign).toHaveBeenCalledWith(
        "https://api.test/program/main/recording/file?ticket=abc",
      ),
    );
    vi.unstubAllGlobals();
  });
});
