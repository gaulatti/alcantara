// Which bracket component a scene's layout places. A layout's componentType is a comma-separated list of component ids
// in play order. The bracket is the one element of that list whose id names a bracket, so the match is on the generic
// word, and a list with two of them is settled by the scene's own state: the element whose key the scene's metadata holds.

function namesBracket(element: string): boolean {
  return element.toLowerCase().includes('bracket');
}

function isAudienceInteraction(element: string): boolean {
  return element.toLowerCase().includes('audience.interaction');
}

/**
 * The bracket element of a layout's componentType, or null when none can be settled. `stateKeys` are the keys of the
 * scene's metadata, which hold each component's props and state.
 */
export function bracketComponentFromLayout(
  componentType: string | null | undefined,
  stateKeys: readonly string[] = [],
): string | null {
  if (typeof componentType !== 'string' || !componentType.trim()) return null;
  const elements = componentType.split(',').map((element) => element.trim()).filter(Boolean);
  if (elements.length === 1) {
    return namesBracket(elements[0]) || isAudienceInteraction(elements[0]) ? elements[0] : null;
  }
  const candidates = elements.filter(namesBracket);
  if (candidates.length === 1) return candidates[0];
  const withState = candidates.filter((element) => stateKeys.includes(element));
  return withState.length === 1 ? withState[0] : null;
}

/**
 * The bracket key of a scene's own state, when exactly one metadata key names a bracket. Used when the layout does not
 * settle the bracket element, so a scene that carries its bracket's state is drawn on that state.
 */
export function bracketComponentFromState(stateKeys: readonly string[]): string | null {
  const keys = stateKeys.filter(namesBracket);
  return keys.length === 1 ? keys[0] : null;
}
