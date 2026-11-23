import { afterEach, expect, it, vi } from "vitest";
import { apiUrl } from "../utils/apiBaseUrl";
import {
  TapeApiError,
  fetchTapeStatus,
  newTapeCommandKey,
  requestTapeDownloadUrl,
  sendTapeCommand,
} from "./tape";

// gaulatti/alcantara#184, group G5: the tape client, through its exported
// calls, with the authenticated fetch it is built on standing in for Alana.
const authFetch = vi.hoisted(() => vi.fn());
vi.mock("./api", () => ({ authFetch }));

afterEach(() => vi.clearAllMocks());

const status = {
  tape: { active: true },
  recording: { state: "recording" },
};
const answer = (body: unknown, init: ResponseInit = {}) =>
  new Response(body === undefined ? "not json" : JSON.stringify(body), init);

async function refusal(promise: Promise<unknown>) {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(TapeApiError);
  return error as TapeApiError;
}

it("reads the tape status of a program, encoding its id", async () => {
  authFetch.mockImplementation(async () => answer(status));
  await expect(fetchTapeStatus("radio one")).resolves.toEqual(status);
  expect(authFetch).toHaveBeenCalledWith("/program/radio%20one/tape");
});

it("starts and stops the tape with an idempotency key", async () => {
  authFetch.mockImplementation(async () => answer(status));
  await sendTapeCommand("p/1", "start", "key-1");
  expect(authFetch).toHaveBeenCalledWith("/program/p%2F1/tape/start", {
    method: "POST",
    headers: { "Idempotency-Key": "key-1" },
  });
  await sendTapeCommand("p", "stop", "key-2");
  expect(authFetch).toHaveBeenLastCalledWith("/program/p/tape/stop", {
    method: "POST",
    headers: { "Idempotency-Key": "key-2" },
  });
});

it("makes a fresh command key per action", () => {
  const start = newTapeCommandKey("start");
  expect(start).toMatch(/^alcantara-tape-start-[0-9a-f-]{36}$/);
  expect(newTapeCommandKey("start")).not.toBe(start);
  expect(newTapeCommandKey("stop")).toMatch(/^alcantara-tape-stop-/);
});

it("explains each refusal Alana can give", async () => {
  const cases: [ResponseInit, unknown, string][] = [
    [{ status: 403 }, {}, "You do not have permission to operate the tape."],
    [{ status: 401 }, {}, "Your session is no longer authorized."],
    [
      { status: 409 },
      { reason: "program-live" },
      "The program is live. End the broadcast before taping.",
    ],
    [{ status: 409 }, { reason: "tape-active" }, "A tape is running."],
    [
      { status: 409 },
      { reason: "already-active" },
      "A tape is already running or finalizing.",
    ],
    [{ status: 409 }, { reason: "not-active" }, "There is no tape to stop."],
    [
      { status: 503 },
      { reason: "disabled" },
      "Taping is not enabled in Alana.",
    ],
    [
      { status: 503 },
      { reason: "pipeline-not-ready" },
      "Alana could not bring up the private program output. Try again.",
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
      "Alana could not capture the program.",
    ],
    [
      { status: 500 },
      { reason: "finalize-failed" },
      "Alana could not finalize the tape.",
    ],
    [
      { status: 500 },
      { reason: "final-artifact-invalid" },
      "Alana could not verify the finished tape.",
    ],
    // An unknown reason, no reason, or no JSON at all.
    [
      { status: 500 },
      { reason: "brand-new" },
      "Taping is temporarily unavailable.",
    ],
    [{ status: 502 }, undefined, "Taping is temporarily unavailable."],
    [{ status: 400 }, { reason: 7 }, "The tape command was rejected."],
    [{ status: 422 }, null, "The tape command was rejected."],
    [{ status: 409 }, "not-an-object", "The tape command was rejected."],
  ];
  for (const [init, body, message] of cases) {
    authFetch.mockResolvedValueOnce(answer(body, init));
    const error = await refusal(fetchTapeStatus("p"));
    expect([error.status, error.message]).toEqual([init.status, message]);
  }
});

it("refuses a success answer that is not a tape status", async () => {
  for (const body of [
    undefined,
    null,
    "text",
    {},
    { tape: {}, recording: { state: "idle" } },
    { tape: { active: "yes" }, recording: { state: "idle" } },
    { tape: { active: false } },
    { tape: { active: false }, recording: { state: 3 } },
  ]) {
    authFetch.mockResolvedValueOnce(answer(body));
    const error = await refusal(sendTapeCommand("p", "start", "k"));
    expect([error.status, error.message]).toEqual([
      502,
      "Taping returned an invalid response.",
    ]);
  }
});

it("turns a download ticket into a browser download URL", async () => {
  authFetch.mockImplementation(async () => answer({ ticket: "t 1&2" }));
  await expect(requestTapeDownloadUrl("p 1")).resolves.toBe(
    apiUrl("/program/p%201/recording/file?ticket=t%201%262"),
  );
  expect(authFetch).toHaveBeenCalledWith(
    "/program/p%201/recording/download-ticket",
    { method: "POST" },
  );
});

it("explains a download that cannot be prepared", async () => {
  const cases: [ResponseInit, unknown, number, string][] = [
    [
      { status: 403 },
      {},
      403,
      "You do not have permission to download the tape.",
    ],
    [{ status: 500 }, { ticket: "t" }, 500, "Could not prepare the download."],
    [{ status: 200 }, undefined, 200, "Could not prepare the download."],
    [{ status: 200 }, { ticket: 9 }, 200, "Could not prepare the download."],
  ];
  for (const [init, body, status, message] of cases) {
    authFetch.mockResolvedValueOnce(answer(body, init));
    const error = await refusal(requestTapeDownloadUrl("p"));
    expect([error.status, error.message]).toEqual([status, message]);
  }
  // A response without a status reads as a bad gateway.
  authFetch.mockResolvedValueOnce({
    ok: false,
    status: 0,
    json: () => Promise.reject(new Error("no body")),
  });
  const error = await refusal(requestTapeDownloadUrl("p"));
  expect([error.status, error.message]).toEqual([
    502,
    "Could not prepare the download.",
  ]);
});
