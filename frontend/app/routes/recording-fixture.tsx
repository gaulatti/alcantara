import { useMemo } from "react";
import { useSearchParams } from "react-router";
import { RecordingStatusView } from "../components/RecordingPanel";
import type { RecordingState, RecordingStatus } from "../models/broadcast";

const states = new Set<RecordingState>([
  "disabled",
  "idle",
  "requested",
  "active",
  "finalizing",
  "complete",
  "failed",
]);

export default function RecordingFixture() {
  const [params] = useSearchParams();
  const stateValue = params.get("state") as RecordingState | null;
  const state = stateValue && states.has(stateValue) ? stateValue : "active";
  const status = useMemo<RecordingStatus>(
    () => ({
      enabled: state !== "disabled",
      state,
      requestedAt: "2026-09-06T18:00:00Z",
      startedAt: "2026-09-06T18:00:01Z",
      stoppedAt:
        state === "finalizing" || state === "complete"
          ? "2026-09-06T18:42:00Z"
          : null,
      finalizedAt: state === "complete" ? "2026-09-06T18:42:04Z" : null,
      updatedAt: "2026-09-06T18:42:04Z",
      segmentCount: 504,
      bytes: 1_940_000_000,
      durationSeconds: 2_520,
      droppedFrames: 0,
      errors: state === "failed" ? 1 : 0,
      restarts: 1,
      finalizationState:
        state === "complete"
          ? "verified"
          : state === "finalizing"
            ? "pending"
            : state === "failed"
              ? "failed"
              : "not-requested",
      finalBytes: state === "complete" ? 1_938_000_000 : 0,
      error: state === "failed" ? "disk-exhausted" : null,
      disk: {
        freeBytes: state === "failed" ? 900_000_000 : 8_000_000_000,
        usageBytes: 1_940_000_000,
        quotaBytes: 50_000_000_000,
        minimumFreeBytes: 1_000_000_000,
      },
    }),
    [state],
  );

  return (
    <main
      className="min-h-screen bg-zinc-950 p-6 text-zinc-100"
      data-visual-fixture={state}
    >
      <RecordingStatusView
        status={status}
        busy={null}
        message=""
        onStart={() => undefined}
        onStop={() => undefined}
        onRefresh={() => undefined}
      />
    </main>
  );
}
