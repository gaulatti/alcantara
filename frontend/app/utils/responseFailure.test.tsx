import { expect, it } from "vitest";
import {
  RESPONSE_FAILURE_MAX_LENGTH,
  failureMessage,
  responseFailure,
  responseFailureReason,
} from "./responseFailure";

// gaulatti/alcantara#253: the operator reads the server's reason for a
// refusal, and the status only when the server gives none.

it("returns the server's message", async () => {
  const response = Response.json(
    { statusCode: 409, message: "Fictional song is already next", error: "Conflict" },
    { status: 409 },
  );
  expect(await responseFailureReason(response)).toBe("Fictional song is already next");
});

it("joins a list of messages into one line", async () => {
  const response = Response.json(
    { message: ["itemId must be a string", "itemId should not be empty"] },
    { status: 400 },
  );
  expect(await responseFailureReason(response)).toBe(
    "itemId must be a string; itemId should not be empty",
  );
});

it("keeps a long or multi-line message to one capped line", async () => {
  const response = Response.json(
    { message: `First line\n\n  second   line ${"x".repeat(400)}` },
    { status: 500 },
  );
  const reason = await responseFailureReason(response);
  expect(reason.startsWith("First line second line x")).toBe(true);
  expect(reason).not.toMatch(/\n/);
  expect(reason).toHaveLength(RESPONSE_FAILURE_MAX_LENGTH);
  expect(reason.endsWith("…")).toBe(true);
});

it.each([
  ["a non-JSON body", () => new Response("<html><b>Bad gateway</b></html>", { status: 502, headers: { "content-type": "text/html" } }), "HTTP 502"],
  ["a JSON type that does not parse", () => new Response("{not json", { status: 503, headers: { "content-type": "application/json" } }), "HTTP 503"],
  ["no body", () => new Response(null, { status: 504 }), "HTTP 504"],
  ["JSON without a message", () => Response.json({ statusCode: 500 }, { status: 500 }), "HTTP 500"],
  ["a blank message", () => Response.json({ message: "   " }, { status: 400 }), "HTTP 400"],
  ["a message of another type", () => Response.json({ message: { nested: "no" } }, { status: 422 }), "HTTP 422"],
  ["a list with a non-string", () => Response.json({ message: ["ok", 3] }, { status: 400 }), "HTTP 400"],
  ["a JSON value that is not an object", () => Response.json("refused", { status: 403 }), "HTTP 403"],
])("falls back to the status for %s", async (_label, make, expected) => {
  expect(await responseFailureReason(make())).toBe(expected);
});

it("wraps the reason in an Error", async () => {
  const error = await responseFailure(Response.json({ message: "Fictional refusal" }, { status: 409 }));
  expect(error).toBeInstanceOf(Error);
  expect(error.message).toBe("Fictional refusal");
});

it("gives a caught failure's text as one capped line", () => {
  expect(failureMessage(new TypeError("Failed to fetch"))).toBe("Failed to fetch");
  expect(failureMessage(new Error(`a\nb ${"y".repeat(400)}`))).toHaveLength(RESPONSE_FAILURE_MAX_LENGTH);
  expect(failureMessage(new Error("  "))).toBe("the request failed");
  expect(failureMessage("not an error")).toBe("the request failed");
});
