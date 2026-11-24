/**
 * What an operator change record may say about a change (gaulatti/alcantara#236). The summary is an
 * allowlist of field names and of values for enum and boolean settings. A field outside the lists is
 * never named, and a URL, key or other free text is never copied, whatever the caller sends.
 */
export const RADIO_SETTINGS_CHANGE_FIELDS = [
  'palazzoUrl',
  'listenerUrl',
  'bumperEnabled',
  'bumperInterval',
  'bumperInstantIds',
  'bumperMode',
  'enabled',
  'segueMode',
  'similarityMode',
  'similarityThreshold',
] as const;

/** Fields whose new value may appear in a summary: booleans, enums and numbers, never a string address. */
const VALUE_FIELDS = new Set([
  'bumperEnabled',
  'bumperInterval',
  'bumperMode',
  'enabled',
  'segueMode',
  'similarityMode',
  'similarityThreshold',
]);

type Scalar = string | number | boolean | null;

export type OperatorChangeSummary = {
  changed: string[];
  /** The setting before the change, for each changed field that may carry a value; null when it had none. */
  before: Record<string, Scalar>;
  /** The setting after the change, for each changed field that may carry a value. */
  after: Record<string, Scalar>;
};

const scalar = (value: unknown): Scalar =>
  typeof value === 'string' ||
  typeof value === 'number' ||
  typeof value === 'boolean'
    ? value
    : null;

/**
 * The summary of a radio-settings change: the names of the fields given and, for the allowlisted
 * enum, boolean and number settings only, their value before and after. `previous` and `current`
 * are the settings rows before and after the write; a URL, key or other text is never copied.
 */
export function radioSettingsChangeSummary(
  data: Record<string, unknown>,
  previous: Record<string, unknown> | null,
  current: Record<string, unknown>,
): OperatorChangeSummary {
  const changed: string[] = [];
  const before: Record<string, Scalar> = {};
  const after: Record<string, Scalar> = {};
  for (const field of RADIO_SETTINGS_CHANGE_FIELDS) {
    if (data[field] === undefined) continue;
    changed.push(field);
    if (!VALUE_FIELDS.has(field)) continue;
    before[field] = scalar(previous?.[field]);
    after[field] = scalar(current[field]);
  }
  return { changed, before, after };
}
