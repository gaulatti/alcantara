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
  newTapeCommandKey,
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

// gaulatti/alcantara#184: the remaining operator states.

describe("TapeStatusView failures", () => {
  it("says the last tape failed and why, and offers a new tape", () => {
    const failed = status("failed");
    failed.recording!.error = "encoder crashed";
    view(failed);
    const headline = screen.getByRole("status");
    expect(headline).toHaveTextContent("The last tape failed");
    expect(headline.className).toContain("text-terracotta");
    expect(screen.getByText("Capture error: encoder crashed")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Tape" })).toBeInTheDocument();
  });

  it("does not show a capture error for a failure without a reason", () => {
    view(status("failed"));
    expect(screen.queryByText(/Capture error/)).toBeNull();
  });

  it("shows progress labels while a command is pending", () => {
    view(status("active", { active: true }), { busy: "stop" });
    expect(screen.getByRole("button", { name: "Finalizing…" })).toBeDisabled();
    cleanup();
    view(status("complete"), { busy: "download" });
    expect(screen.getByRole("button", { name: "Preparing…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Tape" })).toBeDisabled();
  });

  it("offers a status retry when the status is unknown", () => {
    const onRefresh = vi.fn();
    view(null, { onRefresh });
    expect(screen.getByRole("status")).toHaveTextContent("Tape status unavailable");
    fireEvent.click(screen.getByRole("button", { name: "Retry status" }));
    expect(onRefresh).toHaveBeenCalledOnce();
  });
});

describe("TapePanel failures", () => {
  beforeEach(() => {
    vi.mocked(fetchTapeStatus).mockReset();
    vi.mocked(sendTapeCommand).mockReset();
    vi.mocked(requestTapeDownloadUrl).mockReset();
    vi.mocked(newTapeCommandKey).mockClear();
  });

  it("explains an unreadable status and recovers on retry", async () => {
    vi.mocked(fetchTapeStatus)
      .mockRejectedValueOnce(new TapeApiError(503, "The recorder is restarting."))
      .mockResolvedValueOnce(status("idle"));
    render(<TapePanel programId="main" />);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The recorder is restarting.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Retry status" }));
    expect(await screen.findByRole("button", { name: "Tape" })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("uses a generic message for an unexpected failure", async () => {
    vi.mocked(fetchTapeStatus).mockRejectedValue(new Error("socket hang up"));
    render(<TapePanel programId="main" />);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Taping is temporarily unavailable.",
    );
  });

  it("retries a start the server could not finish with the same key", async () => {
    vi.mocked(fetchTapeStatus).mockResolvedValue(status("idle"));
    vi.mocked(sendTapeCommand)
      .mockRejectedValueOnce(new TapeApiError(503, "Try again shortly."))
      .mockResolvedValueOnce(status("active", { active: true }));
    render(<TapePanel programId="main" />);
    fireEvent.click(await screen.findByRole("button", { name: "Tape" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Try again shortly.");
    fireEvent.click(screen.getByRole("button", { name: "Tape" }));
    expect(await screen.findByText("TAPING")).toBeInTheDocument();
    expect(newTapeCommandKey).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sendTapeCommand).mock.calls.map((call) => call[2])).toEqual([
      "tape-start-1",
      "tape-start-1",
    ]);
  });

  it("starts fresh after a refused command, and stops after confirmation", async () => {
    vi.mocked(fetchTapeStatus).mockResolvedValue(status("idle"));
    vi.mocked(sendTapeCommand)
      .mockRejectedValueOnce(new TapeApiError(409, "Busy"))
      .mockResolvedValueOnce(status("active", { active: true }))
      .mockResolvedValueOnce(status("finalizing", { active: true }));
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<TapePanel programId="main" />);
    fireEvent.click(await screen.findByRole("button", { name: "Tape" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Busy");
    fireEvent.click(screen.getByRole("button", { name: "Tape" }));
    fireEvent.click(await screen.findByRole("button", { name: "Stop and save" }));
    expect(await screen.findByText(/not ready yet/)).toBeInTheDocument();
    expect(newTapeCommandKey).toHaveBeenCalledTimes(3);
    expect(sendTapeCommand).toHaveBeenLastCalledWith("main", "stop", "tape-stop-1");
  });

  it("keeps the command error when the status reload after it also fails", async () => {
    vi.mocked(fetchTapeStatus)
      .mockResolvedValueOnce(status("idle"))
      .mockRejectedValue(new Error("offline"));
    vi.mocked(sendTapeCommand).mockRejectedValue(new Error("network"));
    render(<TapePanel programId="main" />);
    fireEvent.click(await screen.findByRole("button", { name: "Tape" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Taping is temporarily unavailable.",
    );
    expect(screen.getByRole("status")).toHaveTextContent("Tape status unavailable");
  });

  it("reports a download link that could not be issued", async () => {
    vi.mocked(fetchTapeStatus).mockResolvedValue(status("complete"));
    vi.mocked(requestTapeDownloadUrl).mockRejectedValue(
      new TapeApiError(410, "The tape has expired."),
    );
    render(<TapePanel programId="main" />);
    fireEvent.click(await screen.findByRole("button", { name: /Download MP4/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The tape has expired.");
    expect(screen.getByRole("button", { name: /Download MP4/ })).toBeEnabled();
  });
});
