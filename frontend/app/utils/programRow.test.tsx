import { describe, expect, it } from 'vitest';
import { normalizeSceneComponentTypes, normalizeSceneMetadata, resolveProgramRow } from './programRow';

const row = (componentType: string) => resolveProgramRow(normalizeSceneComponentTypes(componentType.split(',')));

describe('normalizeSceneComponentTypes', () => {
  it('maps the retired chyron and clock to the Giorgia ones and keeps every other type in order', () => {
    expect(normalizeSceneComponentTypes(['cronica-background', 'modoitaliano-chyron', 'cronica-chyron', 'modoitaliano-clock'])).toEqual([
      'cronica-background',
      'modoitaliano-giorgia-chyron',
      'cronica-chyron',
      'modoitaliano-giorgia-clock'
    ]);
    expect(normalizeSceneComponentTypes(['modoitaliano-clock', 'modoitaliano-bracket'])).toEqual(['modoitaliano-giorgia-clock', 'modoitaliano-bracket']);
  });

  it('lists a type once, at its first position, when a scene names both the retired and the Giorgia id', () => {
    expect(normalizeSceneComponentTypes(['modoitaliano-clock', 'slideshow', 'modoitaliano-giorgia-clock'])).toEqual(['modoitaliano-giorgia-clock', 'slideshow']);
  });
});

describe('normalizeSceneMetadata', () => {
  const chyron = { show: false, textSequence: { mode: 'manual', items: [] } };
  const clock = { showWorldClocks: false, showLogo: false, showPlaybackProgress: false };

  it('gives a Giorgia type the props of the retired type the layout lists', () => {
    expect(
      normalizeSceneMetadata({ 'modoitaliano-chyron': chyron, 'modoitaliano-clock': clock, slideshow: { mediaGroupId: 3 } }, [
        'modoitaliano-chyron',
        'slideshow',
        'modoitaliano-clock'
      ])
    ).toEqual({
      'modoitaliano-chyron': chyron,
      'modoitaliano-clock': clock,
      'modoitaliano-giorgia-chyron': chyron,
      'modoitaliano-giorgia-clock': clock,
      slideshow: { mediaGroupId: 3 }
    });
  });

  it('lets the listed retired type’s props win over an older Giorgia key, as the migration does', () => {
    const metadata = { 'modoitaliano-giorgia-clock': { showLogo: true }, 'modoitaliano-clock': { showLogo: false } };
    expect(normalizeSceneMetadata(metadata, ['modoitaliano-clock'])['modoitaliano-giorgia-clock']).toEqual({ showLogo: false });
  });

  it('leaves the metadata as it is when the layout lists no retired type, or the retired type has no props', () => {
    const leftover = { 'modoitaliano-giorgia-clock': { showLogo: true }, 'modoitaliano-clock': { showLogo: false } };
    expect(normalizeSceneMetadata(leftover, ['modoitaliano-giorgia-clock'])).toBe(leftover);
    const plain = { slideshow: {} };
    expect(normalizeSceneMetadata(plain, ['modoitaliano-clock'])).toBe(plain);
  });
});

describe('resolveProgramRow', () => {
  it('rows the Giorgia clock with the Giorgia chyron, including a scene stored with the retired ids', () => {
    for (const types of ['modoitaliano-giorgia-clock,modoitaliano-giorgia-chyron', 'video-stream,modoitaliano-chyron,modoitaliano-clock']) {
      const plan = row(types);
      expect(plan).toMatchObject({ clockType: 'modoitaliano-giorgia-clock', chyronType: 'modoitaliano-giorgia-chyron' });
      expect([...(plan?.ownedTypes ?? [])].sort()).toEqual(['modoitaliano-giorgia-chyron', 'modoitaliano-giorgia-clock']);
    }
  });

  it('leaves components standalone when there is nothing to pair', () => {
    expect(row('slideshow,modoitaliano-clock')).toBeNull();
    expect(row('modoitaliano-giorgia-clock')).toBeNull();
    expect(row('modoitaliano-giorgia-clock,cronica-chyron')).toBeNull();
    expect(row('modoitaliano-giorgia-clock,modoitaliano-bracket')).toBeNull();
    expect(row('modoitaliano-giorgia-chyron,slideshow')).toBeNull();
    expect(row('modoitaliano-giorgia-podcast-player')).toBeNull();
  });
});
