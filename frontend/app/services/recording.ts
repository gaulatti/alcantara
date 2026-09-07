import type { RecordingStatus } from "../models/broadcast";
import { authFetch } from "./api";

export class RecordingApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const messages: Record<string, string> = {
  "pipeline-not-ready": "Alana is not ready to record the composed program.",
  disabled: "Recording is disabled in Alana.",
  "already-active": "A recording is already active or finalizing.",
  "not-active": "There is no active recording to stop.",
  "disk-exhausted": "Alana does not have enough free disk space.",
  "quota-exhausted": "Alana has reached its recording storage quota.",
  "capture-failed": "Alana could not capture the composed program.",
  "restart-exhausted": "Alana exhausted its recording restart budget.",
  "manifest-corrupt": "Alana could not verify the recording manifest.",
  "segment-corrupt": "Alana found a corrupt recording segment.",
  "finalize-failed": "Alana could not finalize the recording.",
  "final-artifact-invalid": "Alana could not verify the final recording.",
};

async function parseResponse(response: Response): Promise<RecordingStatus> {
  const payload = (await response.json().catch(() => null)) as
    | RecordingStatus
    | { error?: unknown; reason?: unknown }
    | null;
  if (!response.ok) {
    const errorPayload = payload as Record<string, unknown> | null;
    const reason =
      errorPayload && typeof errorPayload.reason === "string"
        ? errorPayload.reason
        : "";
    const message =
      response.status === 403
        ? "You do not have permission to operate recording."
        : response.status === 401
          ? "Your session is no longer authorized."
          : (messages[reason] ??
            (response.status >= 500
              ? "Recording control is temporarily unavailable."
              : "The recording command was rejected."));
    throw new RecordingApiError(response.status, message);
  }
  if (
    !payload ||
    typeof payload !== "object" ||
    !("state" in payload) ||
    typeof payload.state !== "string"
  ) {
    throw new RecordingApiError(
      502,
      "Recording control returned an invalid response.",
    );
  }
  return payload as RecordingStatus;
}

export async function fetchRecordingStatus(
  programId: string,
): Promise<RecordingStatus> {
  const response = await authFetch(
    `/program/${encodeURIComponent(programId)}/recording`,
  );
  return parseResponse(response);
}

export async function sendRecordingCommand(
  programId: string,
  action: "start" | "stop",
  idempotencyKey: string,
): Promise<RecordingStatus> {
  const response = await authFetch(
    `/program/${encodeURIComponent(programId)}/recording/${action}`,
    {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey },
    },
  );
  return parseResponse(response);
}

export function newRecordingCommandKey(action: "start" | "stop"): string {
  return `alcantara-recording-${action}-${crypto.randomUUID()}`;
}
