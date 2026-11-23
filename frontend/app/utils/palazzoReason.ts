/**
 * Why the backend has no Palazzo engine for a program (gaulatti/alcantara#257).
 * `GET /radio/:programId/palazzo-status` carries an optional `reason`; this
 * closed set is additive on the backend, so an unknown value, a missing one and
 * a null body all read as no reason and keep today's wording.
 */
const REASON_TEXT: Record<string, string> = {
  "not-configured": "not configured",
  disabled: "disabled in settings",
  "url-rejected": "URL not allowed",
  "deploy-candidate": "deploy candidate",
};

export function palazzoReasonText(reason: unknown): string | null {
  return typeof reason === "string" &&
    Object.prototype.hasOwnProperty.call(REASON_TEXT, reason)
    ? REASON_TEXT[reason]
    : null;
}

/** "Engine unavailable", with the reason in plain words when the backend gave a known one. */
export function engineUnavailableLabel(
  status: { reason?: unknown } | null | undefined,
): string {
  const text = palazzoReasonText(status?.reason);
  return text ? `Engine unavailable: ${text}` : "Engine unavailable";
}
