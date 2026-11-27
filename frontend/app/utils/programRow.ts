export type ProgramRowClockType = 'modoitaliano-giorgia-clock';
export type ProgramRowChyronType = 'modoitaliano-giorgia-chyron';

export interface ProgramRowPlan {
  /** Clock rendered at the right end of the row. */
  clockType: ProgramRowClockType;
  /** Chyron rendered in the left slot. */
  chyronType: ProgramRowChyronType;
  /** Component types the row renders itself; they must not also render standalone. */
  ownedTypes: ReadonlySet<string>;
}

/**
 * The retired chyron and clock and the Giorgia renderers that replace them. The props contracts are the same, so a
 * scene stored with an old id renders through the new one with the props it already has. The database migration
 * `20261127020000_giorgia_chyron_clock` rewrites stored scenes; this map keeps any scene it missed from going blank.
 */
const RETIRED_COMPONENT_TYPES: Readonly<Record<string, string>> = {
  'modoitaliano-chyron': 'modoitaliano-giorgia-chyron',
  'modoitaliano-clock': 'modoitaliano-giorgia-clock'
};

/** Maps retired ids to their replacement, keeping the list order and the first position of a type listed twice. */
export function normalizeSceneComponentTypes(components: readonly string[]): string[] {
  const normalized: string[] = [];
  for (const type of components) {
    const current = RETIRED_COMPONENT_TYPES[type] ?? type;
    if (!normalized.includes(current)) normalized.push(current);
  }
  return normalized;
}

/**
 * Gives a replacement type the props of the retired type a layout still lists, as the migration does: those are the
 * props the operator has been editing and the audience has been seeing, so they win over an older replacement key.
 * Expects the component list as stored, before `normalizeSceneComponentTypes`.
 */
export function normalizeSceneMetadata(metadata: Record<string, any>, storedComponents: readonly string[]): Record<string, any> {
  let normalized = metadata;
  for (const [retired, current] of Object.entries(RETIRED_COMPONENT_TYPES)) {
    if (storedComponents.includes(retired) && metadata[retired] !== undefined) {
      normalized = { ...normalized, [current]: metadata[retired] };
    }
  }
  return normalized;
}

/**
 * Decides whether a scene's clock and chyron share one bottom row: they do when the scene lists both Giorgia types.
 * Expects the component list after `normalizeSceneComponentTypes`.
 */
export function resolveProgramRow(components: readonly string[]): ProgramRowPlan | null {
  if (components.includes('modoitaliano-giorgia-clock') && components.includes('modoitaliano-giorgia-chyron')) {
    return {
      clockType: 'modoitaliano-giorgia-clock',
      chyronType: 'modoitaliano-giorgia-chyron',
      ownedTypes: new Set<string>(['modoitaliano-giorgia-clock', 'modoitaliano-giorgia-chyron'])
    };
  }
  return null;
}
