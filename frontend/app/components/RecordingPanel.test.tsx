import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RecordingState, RecordingStatus } from "../models/broadcast";
import { RecordingPanel, RecordingStatusView } from "./RecordingPanel";
import {
  fetchRecordingStatus,
  newRecordingCommandKey,
  RecordingApiError,
  sendRecordingCommand,
} from "../services/recording";

vi.mock("../services/recording", async () => {
  class TestRecordingApiError extends Error {
    constructor(
      readonly status: number,
      message: string,
    ) {
      super(message);
    }
  }
  return {
    fetchRecordingStatus: vi.fn(),
    sendRecordingCommand: vi.fn(),
    newRecordingCommandKey: vi.fn(() => "recording-command-1"),
    RecordingApiError: TestRecordingApiError,
  };
});

afterEach(() => cleanup());

const baseStatus = (state: RecordingState = "idle"): RecordingStatus => ({
  enabled: state !== "disabled",
  state,
  requestedAt: "2026-09-06T18:00:00Z",
  startedAt: state === "idle" ? null : "2026-09-06T18:00:01Z",
  stoppedAt: null,
  finalizedAt: null,
  updatedAt: "2026-09-06T18:00:02Z",
  segmentCount: state === "idle" ? 0 : 2,
  bytes: state === "idle" ? 0 : 2_000_000,
  durationSeconds: state === "idle" ? 0 : 10,
  droppedFrames: 0,
  errors: state === "failed" ? 1 : 0,
  restarts: 0,
  finalizationState:
    state === "complete"
      ? "verified"
      : state === "finalizing"
        ? "pending"
        : state === "failed"
          ? "failed"
          : "not-requested",
  finalBytes: state === "complete" ? 1_900_000 : 0,
  error: state === "failed" ? "capture-failed" : null,
  disk: {
    freeBytes: 8_000_000_000,
    usageBytes: 2_000_000,
    quotaBytes: 50_000_000_000,
    minimumFreeBytes: 1_000_000_000,
  },
});

describe("RecordingStatusView", () => {
  it.each([
    ["requested", "Start requested"],
    ["active", "Recording active"],
    ["finalizing", "Finalizing — media is not safe yet"],
    ["complete", "Complete — final artifact verified"],
    ["failed", "Recording failed — broadcast controls remain available"],
  ] as const)("renders the %s lifecycle distinctly", (state, label) => {
    render(
      <RecordingStatusView
        status={baseStatus(state)}
        busy={null}
        message=""
        onStart={vi.fn()}
        onStop={vi.fn()}
        onRefresh={vi.fn()}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent(label);
    expect(screen.queryByText("Program recording")).toBeNull();
    expect(
      screen.getByRole("region", { name: "Program recording" }),
    ).toBeInTheDocument();
    if (state === "active") {
      expect(screen.getByText("REC")).toBeInTheDocument();
    } else {
      expect(screen.queryByText("REC")).toBeNull();
    }
  });

  it("surfaces the Alana disk reserve without exposing a path", () => {
    const status = baseStatus("failed");
    status.error = "disk-exhausted";
    status.disk = {
      freeBytes: 900_000_000,
      usageBytes: 49_000_000_000,
      quotaBytes: 50_000_000_000,
      minimumFreeBytes: 1_000_000_000,
    };
    render(
      <RecordingStatusView
        status={status}
        busy={null}
        message=""
        onStart={vi.fn()}
        onStop={vi.fn()}
        onRefresh={vi.fn()}
      />,
    );
    expect(screen.getByText("Disk warning")).toBeInTheDocument();
    expect(
      screen.getByText("Insufficient free disk space"),
    ).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("/var/lib");
  });
});

describe("RecordingPanel", () => {
  beforeEach(() => {
    vi.mocked(fetchRecordingStatus).mockResolvedValue(baseStatus("idle"));
    vi.mocked(sendRecordingCommand).mockResolvedValue(baseStatus("requested"));
    vi.mocked(newRecordingCommandKey).mockReturnValue("recording-command-1");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("reconciles actual state on load and browser reconnect", async () => {
    render(<RecordingPanel programId="modoitaliano" />);
    await screen.findByText("Ready to record");
    window.dispatchEvent(new Event("online"));
    await waitFor(() => expect(fetchRecordingStatus).toHaveBeenCalledTimes(2));
    expect(fetchRecordingStatus).toHaveBeenCalledWith("modoitaliano");
  });

  it("prevents duplicate submissions and sends one caller-stable command key", async () => {
    let resolveCommand: ((status: RecordingStatus) => void) | undefined;
    vi.mocked(sendRecordingCommand).mockReturnValue(
      new Promise((resolve) => {
        resolveCommand = resolve;
      }),
    );
    render(<RecordingPanel programId="modoitaliano" />);
    const button = await screen.findByRole("button", {
      name: "Start recording",
    });
    fireEvent.click(button);
    expect(screen.getByRole("button", { name: "Requesting…" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Requesting…" }));
    expect(sendRecordingCommand).toHaveBeenCalledTimes(1);
    expect(sendRecordingCommand).toHaveBeenCalledWith(
      "modoitaliano",
      "start",
      "recording-command-1",
    );
    resolveCommand?.(baseStatus("requested"));
    await screen.findByText("Start requested");
  });

  it("requires confirmation before stop and preserves active state on cancel", async () => {
    vi.mocked(fetchRecordingStatus).mockResolvedValue(baseStatus("active"));
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<RecordingPanel programId="modoitaliano" />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Stop and finalize" }),
    );
    expect(confirm).toHaveBeenCalledWith(
      expect.stringContaining("media is not complete until Alana verifies"),
    );
    expect(sendRecordingCommand).not.toHaveBeenCalled();
    expect(screen.getByText("REC")).toBeInTheDocument();
  });

  it("reuses the key after an ambiguous upstream failure and explains permission denial", async () => {
    vi.mocked(sendRecordingCommand)
      .mockRejectedValueOnce(
        new RecordingApiError(
          503,
          "Recording control is temporarily unavailable.",
        ),
      )
      .mockRejectedValueOnce(
        new RecordingApiError(
          403,
          "You do not have permission to operate recording.",
        ),
      );
    render(<RecordingPanel programId="modoitaliano" />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Start recording" }),
    );
    await screen.findByText("Recording control is temporarily unavailable.");
    fireEvent.click(screen.getByRole("button", { name: "Start recording" }));
    await screen.findByText("You do not have permission to operate recording.");
    expect(sendRecordingCommand).toHaveBeenNthCalledWith(
      1,
      "modoitaliano",
      "start",
      "recording-command-1",
    );
    expect(sendRecordingCommand).toHaveBeenNthCalledWith(
      2,
      "modoitaliano",
      "start",
      "recording-command-1",
    );
  });

  it("reuses the key after an ambiguous browser transport failure", async () => {
    vi.mocked(newRecordingCommandKey)
      .mockReturnValueOnce("recording-command-transport-1")
      .mockReturnValueOnce("recording-command-transport-2");
    vi.mocked(sendRecordingCommand)
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockRejectedValueOnce(
        new RecordingApiError(
          403,
          "You do not have permission to operate recording.",
        ),
      );
    render(<RecordingPanel programId="modoitaliano" />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Start recording" }),
    );
    await screen.findByText("Recording control is temporarily unavailable.");
    fireEvent.click(screen.getByRole("button", { name: "Start recording" }));
    await screen.findByText("You do not have permission to operate recording.");

    expect(sendRecordingCommand).toHaveBeenNthCalledWith(
      1,
      "modoitaliano",
      "start",
      "recording-command-transport-1",
    );
    expect(sendRecordingCommand).toHaveBeenNthCalledWith(
      2,
      "modoitaliano",
      "start",
      "recording-command-transport-1",
    );
    expect(newRecordingCommandKey).toHaveBeenCalledTimes(1);
  });
});

// gaulatti/alcantara#184: sizes, durations and the remaining states.

const showStatus = (
  status: RecordingStatus | null,
  overrides: Partial<Parameters<typeof RecordingStatusView>[0]> = {},
) =>
  render(
    <RecordingStatusView
      status={status}
      busy={null}
      message=""
      onStart={vi.fn()}
      onStop={vi.fn()}
      onRefresh={vi.fn()}
      {...overrides}
    />,
  );

describe("RecordingStatusView details", () => {
  it("shows a long single-segment take in hours and bytes, with restarts", () => {
    const status = baseStatus("active");
    status.durationSeconds = 3_725;
    status.bytes = 512;
    status.segmentCount = 1;
    status.restarts = 2;
    status.disk = null;
    showStatus(status);
    expect(screen.getByText(/1:02:05 · 512 B · 1 segment · 2 restarts/)).toBeInTheDocument();
    expect(screen.queryByText("Disk warning")).toBeNull();
  });

  it("shows the verified final size of a complete take", () => {
    showStatus(baseStatus("complete"));
    expect(screen.getByText(/0:10 · 1\.9 MB · 2 segments/)).toBeInTheDocument();
  });

  it("names an unclassified failure and warns when the storage quota is nearly used", () => {
    const status = baseStatus("failed");
    status.error = "solar-flare";
    status.disk = {
      freeBytes: 8_000_000_000,
      usageBytes: 46_000_000_000,
      quotaBytes: 50_000_000_000,
      minimumFreeBytes: 1_000_000_000,
    };
    showStatus(status);
    expect(screen.getByText("Unclassified recording failure")).toBeInTheDocument();
    expect(screen.getByText("Disk warning")).toBeInTheDocument();
  });

  it("does not warn without a quota, and has no failure label without an error", () => {
    const status = baseStatus("failed");
    status.error = null;
    status.disk = {
      freeBytes: 8_000_000_000,
      usageBytes: 46_000_000_000,
      quotaBytes: 0,
      minimumFreeBytes: 1_000_000_000,
    };
    showStatus(status);
    expect(screen.queryByText("Disk warning")).toBeNull();
    expect(screen.queryByText(/Capture failed|Unclassified/)).toBeNull();
  });

  it("labels a stop in progress and a status that could not be read", () => {
    showStatus(baseStatus("active"), { busy: "stop" });
    expect(screen.getByRole("button", { name: "Stopping…" })).toBeDisabled();
    cleanup();
    const onRefresh = vi.fn();
    showStatus(null, { onRefresh });
    expect(screen.getByRole("status")).toHaveTextContent(
      "Recording status unavailable",
    );
    fireEvent.click(screen.getByRole("button", { name: "Retry status" }));
    expect(onRefresh).toHaveBeenCalledOnce();
  });
});

describe("RecordingPanel status failures", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("explains an unreadable status, refreshing on a visible return only", async () => {
    vi.mocked(fetchRecordingStatus)
      .mockRejectedValueOnce(new RecordingApiError(503, "Alana is restarting."))
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(baseStatus("idle"));
    const visibility = vi
      .spyOn(document, "visibilityState", "get")
      .mockReturnValue("hidden");
    render(<RecordingPanel programId="modoitaliano" />);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Alana is restarting.",
    );
    document.dispatchEvent(new Event("visibilitychange"));
    expect(fetchRecordingStatus).toHaveBeenCalledTimes(1);
    visibility.mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Recording control is temporarily unavailable.",
    );
    window.dispatchEvent(new Event("focus"));
    expect(await screen.findByText("Ready to record")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("keeps the command error when the reload after it also fails", async () => {
    vi.mocked(fetchRecordingStatus)
      .mockResolvedValueOnce(baseStatus("active"))
      .mockRejectedValue(new Error("offline"));
    vi.mocked(sendRecordingCommand).mockRejectedValue(
      new RecordingApiError(409, "Already finalizing."),
    );
    // Earlier tests queue "Once" keys that this one must not inherit.
    vi.mocked(newRecordingCommandKey).mockReset().mockReturnValue("recording-command-1");
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<RecordingPanel programId="modoitaliano" />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Stop and finalize" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Already finalizing.",
    );
    expect(sendRecordingCommand).toHaveBeenCalledWith(
      "modoitaliano",
      "stop",
      "recording-command-1",
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "Recording status unavailable",
    );
  });
});

describe("RecordingPanel refresh paths", () => {
  it("asks for the recording status again every two and a half seconds", async () => {
    vi.mocked(fetchRecordingStatus).mockReset();
    vi.mocked(fetchRecordingStatus).mockResolvedValue(baseStatus("idle"));
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      render(<RecordingPanel programId="modoitaliano" />);
      await waitFor(() => expect(fetchRecordingStatus).toHaveBeenCalledTimes(1));
      vi.advanceTimersByTime(2_500);
      await waitFor(() => expect(fetchRecordingStatus).toHaveBeenCalledTimes(2));
    } finally {
      vi.useRealTimers();
    }
  });

  it("asks for the status again from the Retry status button when it could not be read", async () => {
    vi.mocked(fetchRecordingStatus).mockReset();
    vi.mocked(fetchRecordingStatus)
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(baseStatus("idle"));
    render(<RecordingPanel programId="modoitaliano" />);
    fireEvent.click(await screen.findByRole("button", { name: "Retry status" }));
    await waitFor(() => expect(fetchRecordingStatus).toHaveBeenCalledTimes(2));
  });
});
