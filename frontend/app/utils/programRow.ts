export type ProgramRowClockType = 'modoitaliano-clock' | 'modoitaliano-giorgia-clock';
export type ProgramRowChyronType = 'modoitaliano-chyron' | 'modoitaliano-giorgia-chyron';

export interface ProgramRowPlan {
  /** Clock rendered at the right end of the row. */
  clockType: ProgramRowClockType;
  /** Chyron rendered in the left slot, or null when the scene has none. */
  chyronType: ProgramRowChyronType | null;
  /** Whether the disclaimer may take the left slot while no chyron is showing. */
  hasDisclaimer: boolean;
  /** Component types the row renders itself; they must not also render standalone. */
  ownedTypes: ReadonlySet<string>;
}

const DISCLAIMER_TYPE = 'modoitaliano-disclaimer';
/** Components that move the legacy clock from the top-right corner into its bottom row. */
const LEGACY_ROW_COMPANION_TYPES: readonly string[] = [
  'modoitaliano-chyron',
  DISCLAIMER_TYPE,
  'cronica-chyron',
  'modoitaliano-bracket',
  'modoitaliano-podcast-player',
  'modoitaliano-giorgia-podcast-player'
];

/**
 * Decides whether a scene's Modo Italiano clock and chyron share one bottom row.
 *
 * The Giorgia family is the current one and the original family is kept for
 * legacy scenes. The two never pair with each other: a Giorgia clock rows only
 * with the Giorgia chyron, and the legacy clock only with legacy companions.
 * A component of the other family in the same layout renders standalone.
 * A scene never gets two rows; the Giorgia pair wins when both are complete.
 */
export function resolveProgramRow(components: readonly string[]): ProgramRowPlan | null {
  if (components.includes('modoitaliano-giorgia-clock') && components.includes('modoitaliano-giorgia-chyron')) {
    return {
      clockType: 'modoitaliano-giorgia-clock',
      chyronType: 'modoitaliano-giorgia-chyron',
      hasDisclaimer: false,
      ownedTypes: new Set<string>(['modoitaliano-giorgia-clock', 'modoitaliano-giorgia-chyron'])
    };
  }

  if (components.includes('modoitaliano-clock') && LEGACY_ROW_COMPANION_TYPES.some((type) => components.includes(type))) {
    return {
      clockType: 'modoitaliano-clock',
      chyronType: components.includes('modoitaliano-chyron') ? 'modoitaliano-chyron' : null,
      hasDisclaimer: components.includes(DISCLAIMER_TYPE),
      ownedTypes: new Set<string>(['modoitaliano-clock', 'modoitaliano-chyron', DISCLAIMER_TYPE])
    };
  }

  return null;
}
