// The longest reason the console shows for a refused request, in characters.
export const RESPONSE_FAILURE_MAX_LENGTH = 160;

/**
 * Why the server refused a console request, as one line of plain text for the
 * operator (gaulatti/alcantara#253). The server's own `message` is used when
 * it answers with JSON (a string, or a list of strings); anything else, a
 * non-JSON body or one that does not parse, falls back to the HTTP status. The
 * result is plain text: callers render it as text, never as HTML.
 */
export async function responseFailureReason(
  response: Response,
): Promise<string> {
  const fallback = `HTTP ${response.status}`;
  const type = response.headers.get("content-type") ?? "";
  if (!type.toLowerCase().includes("json")) return fallback;
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return fallback;
  }
  const message =
    body && typeof body === "object"
      ? (body as { message?: unknown }).message
      : undefined;
  const text =
    typeof message === "string"
      ? message
      : Array.isArray(message) &&
          message.every((part) => typeof part === "string")
        ? message.join("; ")
        : "";
  return oneLine(text) || fallback;
}

/** An Error carrying {@link responseFailureReason}, for a refused request. */
export async function responseFailure(response: Response): Promise<Error> {
  return new Error(await responseFailureReason(response));
}

/**
 * The one-line text of a caught failure: the reason an Error carries (a
 * refusal from {@link responseFailure}, or a network error), else a generic
 * line, capped like a server's reason.
 */
export function failureMessage(error: unknown): string {
  return (error instanceof Error && oneLine(error.message)) || "the request failed";
}

// Whitespace collapsed to single spaces, capped with an ellipsis.
function oneLine(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > RESPONSE_FAILURE_MAX_LENGTH
    ? `${line.slice(0, RESPONSE_FAILURE_MAX_LENGTH - 1).trimEnd()}…`
    : line;
}
