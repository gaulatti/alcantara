import type { TapeStatus } from "../models/broadcast";
import { apiUrl } from "../utils/apiBaseUrl";
import { authFetch } from "./api";

export class TapeApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const messages: Record<string, string> = {
  disabled: "Taping is not enabled in Alana.",
  "program-live": "The program is live. End the broadcast before taping.",
  "tape-active": "A tape is running.",
  "already-active": "A tape is already running or finalizing.",
  "not-active": "There is no tape to stop.",
  "pipeline-not-ready":
    "Alana could not bring up the private program output. Try again.",
  "disk-exhausted": "Alana does not have enough free disk space.",
  "quota-exhausted": "Alana has reached its recording storage quota.",
  "capture-failed": "Alana could not capture the program.",
  "finalize-failed": "Alana could not finalize the tape.",
  "final-artifact-invalid": "Alana could not verify the finished tape.",
};

function isTapeStatus(value: unknown): value is TapeStatus {
  const candidate = value as Partial<TapeStatus> | null;
  return (
    !!candidate &&
    typeof candidate === "object" &&
    !!candidate.tape &&
    typeof candidate.tape.active === "boolean" &&
    !!candidate.recording &&
    typeof candidate.recording.state === "string"
  );
}

async function parse(response: Response): Promise<TapeStatus> {
  const payload = (await response.json().catch(() => null)) as unknown;
  if (!response.ok) {
    const reason =
      payload &&
      typeof payload === "object" &&
      typeof (payload as { reason?: unknown }).reason === "string"
        ? (payload as { reason: string }).reason
        : "";
    throw new TapeApiError(
      response.status,
      response.status === 403
        ? "You do not have permission to operate the tape."
        : response.status === 401
          ? "Your session is no longer authorized."
          : (messages[reason] ??
            (response.status >= 500
              ? "Taping is temporarily unavailable."
              : "The tape command was rejected.")),
    );
  }
  if (!isTapeStatus(payload)) {
    throw new TapeApiError(502, "Taping returned an invalid response.");
  }
  return payload;
}

export async function fetchTapeStatus(programId: string): Promise<TapeStatus> {
  return parse(
    await authFetch(`/program/${encodeURIComponent(programId)}/tape`),
  );
}

export async function sendTapeCommand(
  programId: string,
  action: "start" | "stop",
  idempotencyKey: string,
): Promise<TapeStatus> {
  return parse(
    await authFetch(
      `/program/${encodeURIComponent(programId)}/tape/${action}`,
      { method: "POST", headers: { "Idempotency-Key": idempotencyKey } },
    ),
  );
}

export function newTapeCommandKey(action: "start" | "stop"): string {
  return `alcantara-tape-${action}-${crypto.randomUUID()}`;
}

/** Returns a short-lived URL a normal browser download can follow. */
export async function requestTapeDownloadUrl(
  programId: string,
): Promise<string> {
  const response = await authFetch(
    `/program/${encodeURIComponent(programId)}/recording/download-ticket`,
    { method: "POST" },
  );
  const payload = (await response.json().catch(() => null)) as {
    ticket?: unknown;
  } | null;
  if (!response.ok || !payload || typeof payload.ticket !== "string") {
    throw new TapeApiError(
      response.status || 502,
      response.status === 403
        ? "You do not have permission to download the tape."
        : "Could not prepare the download.",
    );
  }
  return apiUrl(
    `/program/${encodeURIComponent(programId)}/recording/file?ticket=${encodeURIComponent(payload.ticket)}`,
  );
}
