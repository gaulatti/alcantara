import { afterEach, expect, it, vi } from "vitest";
import {
  RecordingApiError,
  fetchRecordingStatus,
  newRecordingCommandKey,
  sendRecordingCommand,
} from "./recording";

// gaulatti/alcantara#184, group G5: the recording client, through its
// exported calls, with the authenticated fetch standing in for Alana.
const authFetch = vi.hoisted(() => vi.fn());
vi.mock("./api", () => ({ authFetch }));

afterEach(() => vi.clearAllMocks());

const answer = (body: unknown, init: ResponseInit = {}) =>
  new Response(body === undefined ? "not json" : JSON.stringify(body), init);

async function refusal(promise: Promise<unknown>) {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(RecordingApiError);
  return error as RecordingApiError;
}

it("reads the recording status of a program, encoding its id", async () => {
  authFetch.mockImplementation(async () => answer({ state: "idle", extra: 1 }));
  await expect(fetchRecordingStatus("radio one")).resolves.toEqual({
    state: "idle",
    extra: 1,
  });
  expect(authFetch).toHaveBeenCalledWith("/program/radio%20one/recording");
});

it("starts and stops a recording with an idempotency key", async () => {
  authFetch.mockImplementation(async () => answer({ state: "recording" }));
  await sendRecordingCommand("p/1", "start", "key-1");
  expect(authFetch).toHaveBeenCalledWith("/program/p%2F1/recording/start", {
    method: "POST",
    headers: { "Idempotency-Key": "key-1" },
  });
  await sendRecordingCommand("p", "stop", "key-2");
  expect(authFetch).toHaveBeenLastCalledWith("/program/p/recording/stop", {
    method: "POST",
    headers: { "Idempotency-Key": "key-2" },
  });
});

it("makes a fresh command key per action", () => {
  const start = newRecordingCommandKey("start");
  expect(start).toMatch(/^alcantara-recording-start-[0-9a-f-]{36}$/);
  expect(newRecordingCommandKey("start")).not.toBe(start);
  expect(newRecordingCommandKey("stop")).toMatch(/^alcantara-recording-stop-/);
});

it("explains each refusal Alana can give", async () => {
  const cases: [ResponseInit, unknown, string][] = [
    [{ status: 403 }, {}, "You do not have permission to operate recording."],
    [{ status: 401 }, {}, "Your session is no longer authorized."],
    [
      { status: 503 },
      { reason: "pipeline-not-ready" },
      "Alana is not ready to record the composed program.",
    ],
    [
      { status: 503 },
      { reason: "disabled" },
      "Recording is disabled in Alana.",
    ],
    [
      { status: 409 },
      { reason: "already-active" },
      "A recording is already active or finalizing.",
    ],
    [
      { status: 409 },
      { reason: "not-active" },
      "There is no active recording to stop.",
    ],
    [
      { status: 507 },
      { reason: "disk-exhausted" },
      "Alana does not have enough free disk space.",
    ],
    [
      { status: 507 },
      { reason: "quota-exhausted" },
      "Alana has reached its recording storage quota.",
    ],
    [
      { status: 500 },
      { reason: "capture-failed" },
      "Alana could not capture the composed program.",
    ],
    [
      { status: 500 },
      { reason: "restart-exhausted" },
      "Alana exhausted its recording restart budget.",
    ],
    [
      { status: 500 },
      { reason: "manifest-corrupt" },
      "Alana could not verify the recording manifest.",
    ],
    [
      { status: 500 },
      { reason: "segment-corrupt" },
      "Alana found a corrupt recording segment.",
    ],
    [
      { status: 500 },
      { reason: "finalize-failed" },
      "Alana could not finalize the recording.",
    ],
    [
      { status: 500 },
      { reason: "final-artifact-invalid" },
      "Alana could not verify the final recording.",
    ],
    // An unknown reason, a reason that is not text, or no JSON at all.
    [
      { status: 500 },
      { reason: "brand-new" },
      "Recording control is temporarily unavailable.",
    ],
    [
      { status: 502 },
      undefined,
      "Recording control is temporarily unavailable.",
    ],
    [{ status: 400 }, { reason: 7 }, "The recording command was rejected."],
  ];
  for (const [init, body, message] of cases) {
    authFetch.mockResolvedValueOnce(answer(body, init));
    const error = await refusal(fetchRecordingStatus("p"));
    expect([error.status, error.message]).toEqual([init.status, message]);
  }
});

it("refuses a success answer that is not a recording status", async () => {
  for (const body of [undefined, null, "text", {}, { state: 3 }]) {
    authFetch.mockResolvedValueOnce(answer(body));
    const error = await refusal(sendRecordingCommand("p", "start", "k"));
    expect([error.status, error.message]).toEqual([
      502,
      "Recording control returned an invalid response.",
    ]);
  }
});
