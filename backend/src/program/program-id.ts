/**
 * The one rule for a program id outside the program module's own writes: trimmed, not empty, at most 200
 * characters, no slash (it is a path segment) and no control characters. Anything else a program may be named with
 * is accepted, dots included (a domain-style id such as station.fm), and the case is kept: program ids are case-sensitive.
 * Returns null for an id that breaks the rule, so each caller answers with its own error.
 */
export function validProgramId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (
    !normalized ||
    normalized.length > 200 ||
    normalized.includes('/') ||
    [...normalized].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x1f || code === 0x7f;
    })
  )
    return null;
  return normalized;
}
