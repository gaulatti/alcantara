import { useCallback, useEffect, useRef, useState } from "react";
import type { RecordingStatus } from "../models/broadcast";
import {
  fetchRecordingStatus,
  newRecordingCommandKey,
  RecordingApiError,
  sendRecordingCommand,
} from "../services/recording";

const stateLabels: Record<RecordingStatus["state"], string> = {
  disabled: "Recording disabled",
  idle: "Ready to record",
  requested: "Start requested",
  active: "Recording active",
  finalizing: "Finalizing — media is not safe yet",
  complete: "Complete — final artifact verified",
  failed: "Recording failed — broadcast controls remain available",
};

const failureLabels: Record<string, string> = {
  "disk-exhausted": "Insufficient free disk space",
  "quota-exhausted": "Recording storage quota reached",
  "capture-failed": "Capture failed",
  "restart-exhausted": "Recorder restart budget exhausted",
  "manifest-corrupt": "Manifest verification failed",
  "segment-corrupt": "Segment verification failed",
  "finalize-failed": "Finalization failed",
  "final-artifact-invalid": "Final artifact verification failed",
  unknown: "Unclassified recording failure",
};

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(
    Math.floor(Math.log(value) / Math.log(1000)),
    units.length - 1,
  );
  return `${(value / 1000 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function formatDuration(value: number): string {
  const seconds = Math.max(0, Math.floor(value));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`
    : `${minutes}:${String(remainder).padStart(2, "0")}`;
}

function hasDiskWarning(status: RecordingStatus): boolean {
  const disk = status.disk;
  if (!disk) return false;
  return (
    disk.freeBytes <= disk.minimumFreeBytes * 1.25 ||
    (disk.quotaBytes > 0 && disk.usageBytes >= disk.quotaBytes * 0.9)
  );
}

function recordingErrorMessage(error: unknown): string {
  return error instanceof RecordingApiError
    ? error.message
    : "Recording control is temporarily unavailable.";
}

export function RecordingStatusView({
  status,
  busy,
  message,
  onStart,
  onStop,
  onRefresh,
}: {
  status: RecordingStatus | null;
  busy: "start" | "stop" | null;
  message: string;
  onStart: () => void;
  onStop: () => void;
  onRefresh: () => void;
}) {
  const canStart =
    status?.enabled === true &&
    ["idle", "complete", "failed"].includes(status.state);
  const canStop =
    status?.enabled === true && ["requested", "active"].includes(status.state);
  const diskWarning = status ? hasDiskWarning(status) : false;

  return (
    <section
      aria-label="Program recording"
      data-recording-state={status?.state ?? "unavailable"}
      className="mx-3 mt-3 rounded-xl border border-zinc-700 bg-zinc-950/90 px-4 py-3 shadow-lg"
    >
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-xs font-bold uppercase tracking-[0.2em] text-zinc-300">
              Program recording
            </h2>
            {status?.state === "active" ? (
              <span className="rounded bg-red-600 px-2 py-0.5 text-[10px] font-black tracking-widest text-white shadow-[0_0_12px_rgba(220,38,38,0.5)]">
                REC
              </span>
            ) : null}
            {diskWarning ? (
              <span className="rounded border border-amber-600/60 bg-amber-950 px-2 py-0.5 text-[10px] font-bold uppercase text-amber-200">
                Disk warning
              </span>
            ) : null}
          </div>
          <p
            role="status"
            aria-live="polite"
            className={`mt-1 text-sm font-semibold ${status?.state === "failed" ? "text-red-300" : status?.state === "finalizing" ? "text-amber-300" : "text-zinc-100"}`}
          >
            {status
              ? stateLabels[status.state]
              : "Recording status unavailable"}
          </p>
          {status ? (
            <p className="mt-1 text-xs text-zinc-400">
              {formatDuration(status.durationSeconds)} ·{" "}
              {formatBytes(
                status.state === "complete" && status.finalBytes > 0
                  ? status.finalBytes
                  : status.bytes,
              )}{" "}
              · {status.segmentCount} segment
              {status.segmentCount === 1 ? "" : "s"}
              {status.restarts > 0 ? ` · ${status.restarts} restarts` : ""}
            </p>
          ) : null}
          {status?.state === "failed" && status.error ? (
            <p className="mt-1 text-xs text-red-300">
              {failureLabels[status.error] ?? failureLabels.unknown}
            </p>
          ) : null}
          {diskWarning && status?.disk ? (
            <p className="mt-1 text-xs text-amber-300">
              {formatBytes(status.disk.freeBytes)} free; recording requires a{" "}
              {formatBytes(status.disk.minimumFreeBytes)} reserve.
            </p>
          ) : null}
          {message ? (
            <p role="alert" className="mt-1 text-xs text-amber-200">
              {message}
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {!status ? (
            <button
              type="button"
              onClick={onRefresh}
              className="rounded border border-zinc-600 bg-zinc-800 px-3 py-2 text-xs font-bold text-zinc-100 hover:bg-zinc-700"
            >
              Retry status
            </button>
          ) : null}
          {canStart ? (
            <button
              type="button"
              onClick={onStart}
              disabled={busy !== null}
              className="rounded border border-red-500/70 bg-red-950 px-4 py-2 text-xs font-black uppercase tracking-widest text-red-100 hover:bg-red-900 disabled:cursor-wait disabled:opacity-50"
            >
              {busy === "start" ? "Requesting…" : "Start recording"}
            </button>
          ) : null}
          {canStop ? (
            <button
              type="button"
              onClick={onStop}
              disabled={busy !== null}
              className="rounded border border-amber-500/70 bg-amber-950 px-4 py-2 text-xs font-black uppercase tracking-widest text-amber-100 hover:bg-amber-900 disabled:cursor-wait disabled:opacity-50"
            >
              {busy === "stop" ? "Stopping…" : "Stop and finalize"}
            </button>
          ) : null}
        </div>
      </div>
    </section>
  );
}

export function RecordingPanel({ programId }: { programId: string }) {
  const [status, setStatus] = useState<RecordingStatus | null>(null);
  const [busy, setBusy] = useState<"start" | "stop" | null>(null);
  const [message, setMessage] = useState("");
  const retryCommand = useRef<{
    action: "start" | "stop";
    key: string;
  } | null>(null);

  const refresh = useCallback(
    async (clearMessage = true) => {
      try {
        setStatus(await fetchRecordingStatus(programId));
        if (clearMessage) setMessage("");
      } catch (error) {
        setStatus(null);
        if (clearMessage) {
          setMessage(recordingErrorMessage(error));
        }
      }
    },
    [programId],
  );

  useEffect(() => {
    setStatus(null);
    setMessage("");
    retryCommand.current = null;
    void refresh();
    const timer = window.setInterval(() => void refresh(), 2_500);
    const reconcile = () => void refresh();
    const reconcileVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    window.addEventListener("focus", reconcile);
    window.addEventListener("online", reconcile);
    document.addEventListener("visibilitychange", reconcileVisible);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", reconcile);
      window.removeEventListener("online", reconcile);
      document.removeEventListener("visibilitychange", reconcileVisible);
    };
  }, [refresh]);

  const command = async (action: "start" | "stop") => {
    if (
      action === "stop" &&
      !window.confirm(
        "Stop recording and begin finalization? Recording cannot resume, and the media is not complete until Alana verifies the final artifact.",
      )
    ) {
      return;
    }
    const pending = retryCommand.current;
    const key =
      pending?.action === action ? pending.key : newRecordingCommandKey(action);
    setBusy(action);
    setMessage("");
    try {
      const next = await sendRecordingCommand(programId, action, key);
      retryCommand.current = null;
      setStatus(next);
    } catch (error) {
      if (!(error instanceof RecordingApiError) || error.status >= 500) {
        retryCommand.current = { action, key };
      } else {
        retryCommand.current = null;
      }
      setMessage(recordingErrorMessage(error));
      await refresh(false);
    } finally {
      setBusy(null);
    }
  };

  return (
    <RecordingStatusView
      status={status}
      busy={busy}
      message={message}
      onStart={() => void command("start")}
      onStop={() => void command("stop")}
      onRefresh={() => void refresh()}
    />
  );
}
