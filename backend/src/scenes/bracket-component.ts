// gaulatti/alcantara#391: which bracket component a scene's layout places. A layout's componentType is a comma-separated
// list of component ids in play order, so the bracket is the one element of that list, never a substring of the whole.

export const GIORGIA_BRACKET_COMPONENT = 'modoitaliano-giorgia-bracket';
export const LEGACY_BRACKET_COMPONENT = 'modoitaliano-bracket';

function isBracketLike(type: string): boolean {
  const normalized = type.trim().toLowerCase();
  return normalized.includes('bracket') || normalized.includes('audience.interaction');
}

/**
 * The bracket element of a layout's componentType, or null when the layout places none. A single-element list is read as
 * before. In a longer list only an element equal to a known bracket id counts, and only when exactly one does: a list
 * with two bracket elements, or a lookalike such as `tournament-bracket`, is not guessed at.
 */
export function bracketComponentFromLayout(componentType: string | null | undefined): string | null {
  if (typeof componentType !== 'string' || !componentType.trim()) return null;
  const elements = componentType.split(',').map((element) => element.trim()).filter(Boolean);
  if (elements.length === 1) return isBracketLike(elements[0]) ? elements[0] : null;
  const known = elements.filter((element) => element === GIORGIA_BRACKET_COMPONENT || element === LEGACY_BRACKET_COMPONENT);
  return known.length === 1 ? known[0] : null;
}
