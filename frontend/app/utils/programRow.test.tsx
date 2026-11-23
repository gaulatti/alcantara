import { describe, expect, it } from 'vitest';
import { resolveProgramRow } from './programRow';

const row = (componentType: string) => resolveProgramRow(componentType.split(','));

describe('resolveProgramRow', () => {
  it('pairs each clock with its own family chyron', () => {
    expect(row('video-stream,modoitaliano-chyron,modoitaliano-clock')).toMatchObject({
      clockType: 'modoitaliano-clock',
      chyronType: 'modoitaliano-chyron'
    });
    expect(row('modoitaliano-giorgia-clock,modoitaliano-giorgia-chyron')).toMatchObject({
      clockType: 'modoitaliano-giorgia-clock',
      chyronType: 'modoitaliano-giorgia-chyron'
    });
  });

  it('never pairs the legacy and Giorgia families with each other', () => {
    expect(row('modoitaliano-clock,slideshow,modoitaliano-giorgia-chyron')).toBeNull();
    expect(row('modoitaliano-giorgia-clock,modoitaliano-chyron')).toBeNull();
    expect(row('modoitaliano-giorgia-clock,modoitaliano-disclaimer')).toBeNull();
    expect(row('modoitaliano-giorgia-clock,modoitaliano-bracket')).toBeNull();
  });

  it('builds a single Giorgia row when both families are fully present, leaving the legacy pair standalone', () => {
    const plan = row('modoitaliano-clock,modoitaliano-chyron,modoitaliano-giorgia-clock,modoitaliano-giorgia-chyron');
    expect(plan).toMatchObject({ clockType: 'modoitaliano-giorgia-clock', chyronType: 'modoitaliano-giorgia-chyron', hasDisclaimer: false });
    expect([...(plan?.ownedTypes ?? [])].sort()).toEqual(['modoitaliano-giorgia-chyron', 'modoitaliano-giorgia-clock']);
  });

  it('moves the legacy clock into its row beside legacy companions', () => {
    for (const companion of [
      'modoitaliano-disclaimer',
      'cronica-chyron',
      'modoitaliano-bracket',
      'modoitaliano-podcast-player',
      'modoitaliano-giorgia-podcast-player'
    ]) {
      const plan = row(`modoitaliano-clock,slideshow,${companion}`);
      expect(plan).toMatchObject({ clockType: 'modoitaliano-clock', chyronType: null, hasDisclaimer: companion === 'modoitaliano-disclaimer' });
      expect([...(plan?.ownedTypes ?? [])].sort()).toEqual(['modoitaliano-chyron', 'modoitaliano-clock', 'modoitaliano-disclaimer']);
    }
  });

  it('leaves components standalone when there is nothing to pair', () => {
    expect(row('slideshow,modoitaliano-clock')).toBeNull();
    expect(row('modoitaliano-giorgia-clock')).toBeNull();
    expect(row('modoitaliano-giorgia-chyron,slideshow')).toBeNull();
    expect(row('modoitaliano-giorgia-podcast-player')).toBeNull();
  });
});
