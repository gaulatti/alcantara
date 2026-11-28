// gaulatti/alcantara#391: the dead tournament-bracket element and key are removed from layout 2236 and scene 74, and
// nothing else. The specs use the real production values.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const removal = require('../../scripts/remove-tournament-bracket.cjs');

const REAL_LIST =
  'modoitaliano-giorgia-clock,tournament-bracket,modoitaliano-giorgia-bracket,slideshow';
const REAL_LIST_AFTER =
  'modoitaliano-giorgia-clock,modoitaliano-giorgia-bracket,slideshow';
const REAL_KEYS = [
  'slideshow',
  'sceneInstant',
  'tournament-bracket',
  'modoitaliano-giorgia-bracket',
  'modoitaliano-giorgia-clock',
];

const realMetadata = () => {
  const metadata: Record<string, unknown> = {};
  for (const key of REAL_KEYS)
    metadata[key] =
      key === 'tournament-bracket' ? { matches: [] } : { show: true };
  return JSON.stringify(metadata);
};
const layout = (componentType: string) => ({
  id: 2236,
  name: 'MI-Mundial',
  componentType,
});

describe('tournament-bracket removal', () => {
  it('removes only the tournament-bracket element of the real list, keeping the order of the rest', () => {
    const plan = removal.planLayout(layout(REAL_LIST));
    expect(plan.componentTypeAfter).toBe(REAL_LIST_AFTER);
    expect(plan.index).toBe(1);
  });

  it('removes only the tournament-bracket key of the real scene 74, keeping the other keys in order', () => {
    const plan = removal.planScene(74, realMetadata());
    expect(plan.keysBefore).toEqual(REAL_KEYS);
    expect(plan.keysAfter).toEqual([
      'slideshow',
      'sceneInstant',
      'modoitaliano-giorgia-bracket',
      'modoitaliano-giorgia-clock',
    ]);
    const original = JSON.parse(realMetadata());
    expect(JSON.parse(plan.scrubbedMetadata)).toEqual(
      Object.fromEntries(
        Object.entries(original).filter(
          ([key]) => key !== 'tournament-bracket',
        ),
      ),
    );
  });

  it('reverts both to the exact original text, the element back at its position', () => {
    const plan = removal.planLayout(layout(REAL_LIST));
    const scene = removal.planScene(74, realMetadata());
    const revert = removal.planRevert(
      {
        originalComponentType: REAL_LIST,
        scrubbedComponentType: plan.componentTypeAfter,
        originalMetadata: scene.originalMetadata,
        scrubbedMetadata: scene.scrubbedMetadata,
      },
      plan.componentTypeAfter,
      scene.scrubbedMetadata,
    );
    expect(revert.restoredComponentType).toBe(REAL_LIST);
    expect(revert.restoredMetadata).toBe(realMetadata());
    expect(removal.insertListElement(REAL_LIST_AFTER, 1).value).toBe(REAL_LIST);
  });

  it('is already applied once the element is gone, for both the layout and the scene', () => {
    expect(removal.planLayout(layout(REAL_LIST_AFTER)).alreadyRemoved).toBe(
      true,
    );
    expect(
      removal.planScene(74, JSON.stringify({ slideshow: {} })).alreadyRemoved,
    ).toBe(true);
  });

  it('refuses a layout that is not MI-Mundial, an element that appears twice, and a list that is not text', () => {
    expect(
      removal.planLayout({
        id: 2237,
        name: 'MI-Podcast',
        componentType: REAL_LIST,
      }).refused,
    ).toMatch(/not MI-Mundial/);
    expect(
      removal.planLayout(layout(`${REAL_LIST},tournament-bracket`)).refused,
    ).toMatch(/appears 2 times/);
    expect(
      removal.planLayout({ id: 2236, name: 'MI-Mundial', componentType: null })
        .refused,
    ).toMatch(/not text/);
  });

  it('matches the element exactly, so a lookalike is left alone', () => {
    expect(
      removal.planLayout(layout('my-tournament-bracket-v2,slideshow'))
        .alreadyRemoved,
    ).toBe(true);
  });

  it('refuses scene 74 when its metadata is not an object, or the key holds something that is not an object', () => {
    expect(removal.planScene(74, '[1]').refused).toMatch(/not a JSON object/);
    expect(removal.planScene(74, '{not json').refused).toMatch(/not JSON/);
    expect(
      removal.planScene(74, JSON.stringify({ 'tournament-bracket': 'text' }))
        .refused,
    ).toMatch(/not an object/);
    expect(removal.planScene(75, realMetadata()).refused).toMatch(
      /is not scene 74/,
    );
  });

  it('refuses a revert onto a row that changed since the removal', () => {
    const revert = removal.planRevert(
      {
        originalComponentType: REAL_LIST,
        scrubbedComponentType: REAL_LIST_AFTER,
        originalMetadata: '{}',
        scrubbedMetadata: '{}',
      },
      'modoitaliano-giorgia-clock,slideshow',
      '{}',
    );
    expect(revert.refused).toMatch(/layout changed since the removal/);
  });

  it('refuses a database host that is not local unless told otherwise', () => {
    expect(removal.hostAllowed('postgres://u:p@localhost:5432/db', false)).toBe(
      true,
    );
    expect(
      removal.hostAllowed('postgres://u:p@db.example.com:5432/db', false),
    ).toBe(false);
    expect(
      removal.hostAllowed('postgres://u:p@db.example.com:5432/db', true),
    ).toBe(true);
  });
});
