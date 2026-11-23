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

export type OperatorChangeSummary = {
  changed: string[];
  values: Record<string, string | number | boolean>;
};

/** The summary of a radio-settings change: the names of the fields given, and the new value of the allowlisted ones. */
export function radioSettingsChangeSummary(
  data: Record<string, unknown>,
): OperatorChangeSummary {
  const changed: string[] = [];
  const values: Record<string, string | number | boolean> = {};
  for (const field of RADIO_SETTINGS_CHANGE_FIELDS) {
    const value = data[field];
    if (value === undefined) continue;
    changed.push(field);
    if (
      VALUE_FIELDS.has(field) &&
      (typeof value === 'string' ||
        typeof value === 'number' ||
        typeof value === 'boolean')
    ) {
      values[field] = value;
    }
  }
  return { changed, values };
}
