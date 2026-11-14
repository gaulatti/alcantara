import { Button } from "@gaulatti/bleecker";
import { useCallback, useEffect, useRef, useState } from "react";
import type { TapeStatus } from "../models/broadcast";
import {
  fetchTapeStatus,
  newTapeCommandKey,
  requestTapeDownloadUrl,
  sendTapeCommand,
  TapeApiError,
} from "../services/tape";
import { formatBytes, formatDuration } from "./RecordingPanel";

type Busy = "start" | "stop" | "download" | null;

function tapeErrorMessage(error: unknown): string {
  return error instanceof TapeApiError
    ? error.message
    : "Taping is temporarily unavailable.";
}

export function TapeStatusView({
  status,
  busy,
  message,
  onStart,
  onStop,
  onDownload,
  onRefresh,
}: {
  status: TapeStatus | null;
  busy: Busy;
  message: string;
  onStart: () => void;
  onStop: () => void;
  onDownload: () => void;
  onRefresh: () => void;
}) {
  const recording = status?.recording ?? null;
  const enabled = status?.tape.enabled === true;
  const active = status?.tape.active === true;
  const finalizing = recording?.state === "finalizing";
  const taping = active && !finalizing;
  const canTape =
    enabled &&
    !active &&
    !finalizing &&
    (recording === null ||
      ["idle", "complete", "failed", "disabled"].includes(recording.state));
  const ready =
    !active &&
    recording?.state === "complete" &&
    recording.finalizationState === "verified" &&
    recording.finalBytes > 0;

  let headline = "Tape status unavailable";
  if (status) {
    if (!enabled) headline = "Taping is not enabled";
    else if (finalizing) headline = "Finalizing — the file is not ready yet";
    else if (taping) headline = "Taping — private, not broadcast";
    else if (ready) headline = "Tape ready to download";
    else if (recording?.state === "failed")
      headline = "The last tape failed";
    else headline = "Ready to tape";
  }

  return (
    <section
      aria-label="Program tape"
      data-tape-state={taping ? "taping" : (recording?.state ?? "unavailable")}
      className="px-4 py-3 text-text-primary"
    >
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div className="min-w-0">
          {taping ? (
            <span className="rounded bg-red-600 px-2 py-0.5 text-[10px] font-black tracking-widest text-white">
              TAPING
            </span>
          ) : null}
          <p
            role="status"
            aria-live="polite"
            className={`mt-1 text-sm font-semibold ${recording?.state === "failed" && !active ? "text-terracotta" : ""}`}
          >
            {headline}
          </p>
          {recording && (active || ready) ? (
            <p className="mt-1 text-xs text-text-secondary">
              {formatDuration(recording.durationSeconds)} ·{" "}
              {formatBytes(
                ready && recording.finalBytes > 0
                  ? recording.finalBytes
                  : recording.bytes,
              )}
            </p>
          ) : null}
          {recording?.state === "failed" && recording.error ? (
            <p className="mt-1 text-xs text-red-300">
              Capture error: {recording.error}
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
            <Button type="button" size="sm" variant="secondary" onClick={onRefresh}>
              Retry status
            </Button>
          ) : null}
          {canTape ? (
            <Button
              type="button"
              size="sm"
              variant="destructive"
              disabled={busy !== null}
              onClick={onStart}
            >
              {busy === "start" ? "Starting private output…" : "Tape"}
            </Button>
          ) : null}
          {taping ? (
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={busy !== null}
              onClick={onStop}
            >
              {busy === "stop" ? "Finalizing…" : "Stop and save"}
            </Button>
          ) : null}
          {ready ? (
            <Button
              type="button"
              size="sm"
              disabled={busy !== null}
              onClick={onDownload}
            >
              {busy === "download"
                ? "Preparing…"
                : `Download MP4 (${formatBytes(recording?.finalBytes ?? 0)})`}
            </Button>
          ) : null}
        </div>
      </div>
    </section>
  );
}

export function TapePanel({ programId }: { programId: string }) {
  const [status, setStatus] = useState<TapeStatus | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [message, setMessage] = useState("");
  const retryCommand = useRef<{ action: "start" | "stop"; key: string } | null>(
    null,
  );

  const refresh = useCallback(
    async (clearMessage = true) => {
      try {
        setStatus(await fetchTapeStatus(programId));
        if (clearMessage) setMessage("");
      } catch (error) {
        setStatus(null);
        if (clearMessage) setMessage(tapeErrorMessage(error));
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
    return () => window.clearInterval(timer);
  }, [refresh]);

  const command = async (action: "start" | "stop") => {
    if (
      action === "stop" &&
      !window.confirm(
        "Stop the tape and save the file? Taping cannot resume after this.",
      )
    ) {
      return;
    }
    const pending = retryCommand.current;
    const key =
      pending?.action === action ? pending.key : newTapeCommandKey(action);
    setBusy(action);
    setMessage("");
    try {
      setStatus(await sendTapeCommand(programId, action, key));
      retryCommand.current = null;
    } catch (error) {
      retryCommand.current =
        !(error instanceof TapeApiError) || error.status >= 500
          ? { action, key }
          : null;
      setMessage(tapeErrorMessage(error));
      await refresh(false);
    } finally {
      setBusy(null);
    }
  };

  const download = async () => {
    setBusy("download");
    setMessage("");
    try {
      window.location.assign(await requestTapeDownloadUrl(programId));
    } catch (error) {
      setMessage(tapeErrorMessage(error));
    } finally {
      setBusy(null);
    }
  };

  return (
    <TapeStatusView
      status={status}
      busy={busy}
      message={message}
      onStart={() => void command("start")}
      onStop={() => void command("stop")}
      onDownload={() => void download()}
      onRefresh={() => void refresh()}
    />
  );
}
